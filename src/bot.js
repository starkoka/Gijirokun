import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import {
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import sodium from 'libsodium-wrappers';
import { loadConfig } from './config.js';
import { GeminiSummarizer } from './gemini.js';
import { PythonTranscriber } from './python-transcriber.js';
import { MeetingSession } from './session.js';

const COMMAND_DEFINITIONS = [
  new SlashCommandBuilder().setName('start').setDescription('VC の議事録作成を開始します'),
  new SlashCommandBuilder().setName('stop').setDescription('議事録作成を終了して出力します'),
].map((command) => command.toJSON());

export async function startBot() {
  await sodium.ready;

  const config = loadConfig();
  const logger = console;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const summarizer = new GeminiSummarizer({
    apiKey: config.geminiApiKey,
    modelName: config.geminiModel,
  });
  const transcriber = new PythonTranscriber({
    pythonExecutable: config.pythonExecutable,
    scriptPath: config.transcriberScriptPath,
    modelPath: config.voskModelPath,
    ffmpegBinary: config.ffmpegBinary,
    logger,
  });
  await transcriber.ensureStarted();
  const sessions = new Map();
  let shutdownPromise = null;

  client.once(Events.ClientReady, async (readyClient) => {
    logger.info(`Logged in as ${readyClient.user.tag}`);
    try {
      await registerCommands(readyClient, config);
      logger.info('Slash commands registered.');
    } catch (error) {
      logger.error('Failed to register slash commands:', error);
    }
  });

  client.on(Events.MessageCreate, (message) => {
    if (!message.guildId || message.author.bot) {
      return;
    }

    const session = sessions.get(message.guildId);
    if (!session || message.channelId !== session.textChannel.id) {
      return;
    }

    session.addTextMessage(message);
  });

  client.on(Events.VoiceStateUpdate, async (before, after) => {
    const guildId = after.guild.id;
    const session = sessions.get(guildId);
    if (!session || session.stopRequested) {
      return;
    }

    const watchedChannelId = session.voiceChannel.id;
    const changedChannelIds = new Set([before.channelId, after.channelId]);
    if (!changedChannelIds.has(watchedChannelId)) {
      return;
    }

    const humanCount = session.voiceChannel.members.filter((member) => !member.user.bot).size;
    if (humanCount !== 0) {
      return;
    }

    try {
      const artifacts = await session.stop({
        reason: 'VC から人がいなくなったため、自動で議事録作成を終了しました。',
      });
      sessions.delete(guildId);
      await sendArtifacts(session.textChannel, artifacts);
    } catch (error) {
      logger.error(`Failed to auto-stop session for guild ${guildId}:`, error);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName === 'start') {
      await handleStart({
        interaction,
        client,
        config,
        summarizer,
        transcriber,
        sessions,
        logger,
      });
      return;
    }

    if (interaction.commandName === 'stop') {
      await handleStop({ interaction, sessions, logger });
    }
  });

  client.on(Events.Error, (error) => {
    logger.error(error);
  });

  const shutdown = async () => {
    if (shutdownPromise) {
      return await shutdownPromise;
    }

    shutdownPromise = (async () => {
      for (const [guildId, session] of sessions.entries()) {
        try {
          const artifacts = await session.stop({
            reason: 'Bot を終了するため、議事録作成を終了しました。',
          });
          await sendArtifacts(session.textChannel, artifacts);
          sessions.delete(guildId);
        } catch (error) {
          logger.error('Failed to stop session during shutdown:', error);
        }
      }

      await transcriber.close().catch((error) => {
        logger.error('Failed to close Python transcriber:', error);
      });

      client.destroy();
    })();

    return await shutdownPromise;
  };

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });

  await client.login(config.discordBotToken);
}

async function handleStart({
  interaction,
  client,
  config,
  summarizer,
  transcriber,
  sessions,
  logger,
}) {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: 'このコマンドはサーバー内でのみ利用できます。',
      ephemeral: true,
    });
    return;
  }

  if (sessions.has(interaction.guildId)) {
    await interaction.reply({
      content: 'このサーバーではすでに議事録作成中のセッションがあります。',
      ephemeral: true,
    });
    return;
  }

  const textChannel = interaction.channel;
  if (!textChannel?.isTextBased() || !('send' in textChannel)) {
    await interaction.reply({
      content: 'このチャンネルでは議事録を出力できません。通常のテキストチャンネルで実行してください。',
      ephemeral: true,
    });
    return;
  }

  const member = interaction.member;
  const voiceChannel = member.voice.channel;
  if (!voiceChannel) {
    await interaction.reply({
      content: '先にボイスチャンネルへ参加してください。',
      ephemeral: true,
    });
    return;
  }

  if (![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(voiceChannel.type)) {
    await interaction.reply({
      content: '対応していないチャンネル種別です。',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  let connection = null;
  try {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

    const session = new MeetingSession({
      client,
      config,
      guild: interaction.guild,
      voiceChannel,
      textChannel,
      connection,
      summarizer,
      transcriber,
      logger,
    });
    await session.initialize();
    sessions.set(interaction.guildId, session);

    await interaction.editReply(
      [
        '議事録を取り始めたよ！',
        `録音対象 VC: \`${voiceChannel.name}\``,
        `記録対象テキストチャンネル: ${textChannel}`,
        '終了するときは `/stop` を実行してください。',
      ].join('\n'),
    );
  } catch (error) {
    logger.error('Failed to start session:', error);

    try {
      connection?.destroy();
    } catch {
      // Ignore destroy failures during start rollback.
    }

    await interaction.editReply(
      `録音開始に失敗しました: ${error.message || 'Discord Voice への接続に失敗しました。'}`,
    );
  }
}

async function handleStop({ interaction, sessions, logger }) {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: 'このコマンドはサーバー内でのみ利用できます。',
      ephemeral: true,
    });
    return;
  }

  const session = sessions.get(interaction.guildId);
  if (!session) {
    await interaction.reply({
      content: '現在進行中の議事録セッションはありません。',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const artifacts = await session.stop({ reason: null });
    sessions.delete(interaction.guildId);
    await sendArtifacts(session.textChannel, artifacts);
    const warningText = artifacts.warnings.length
      ? '\n注意: 一部の音声チャンクで文字起こしに失敗しました。README のトラブルシュートを確認してください。'
      : '';
    await interaction.editReply(`議事録の作成を終了しました。${warningText}`);
  } catch (error) {
    logger.error('Failed to stop session:', error);
    await interaction.editReply(`停止処理に失敗しました: ${error.message}`);
  }
}

async function sendArtifacts(textChannel, artifacts) {
  if (artifacts.stopReason) {
    await textChannel.send(artifacts.stopReason);
  }

  const transcriptAttachment = new AttachmentBuilder(artifacts.transcriptPath, {
    name: 'transcript_cache.txt',
  });

  if (artifacts.markdownText.length <= 2000) {
    await textChannel.send({
      content: artifacts.markdownText,
      files: [transcriptAttachment],
    });
    return;
  }

  const minutesAttachment = new AttachmentBuilder(artifacts.minutesPath, {
    name: 'minutes.md',
  });
  await textChannel.send({
    content: '議事録が 2,000 文字を超えたため、Markdown ファイルとして添付します。',
    files: [minutesAttachment, transcriptAttachment],
  });
}

async function registerCommands(client, config) {
  const rest = new REST({ version: '10' }).setToken(config.discordBotToken);

  if (config.commandGuildIds.length) {
    for (const guildId of config.commandGuildIds) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
        body: COMMAND_DEFINITIONS,
      });
    }
    return;
  }

  await rest.put(Routes.applicationCommands(client.user.id), {
    body: COMMAND_DEFINITIONS,
  });
}
