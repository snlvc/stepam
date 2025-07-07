import {
  ChannelType,
  type Content,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  type Media,
  type Memory,
  ModelType,
  type UUID,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import type { Chat, Message, ReactionType, Update } from '@telegraf/types';
import type { CallbackQuery } from '@telegraf/types';
import type { Context, NarrowedContext, Telegraf } from 'telegraf';
import { Markup } from 'telegraf';
import {
  TelegramContent,
  TelegramEventTypes,
  type TelegramMessageReceivedPayload,
  type TelegramMessageSentPayload,
  type TelegramReactionReceivedPayload,
  type Button,
} from './types';
import { convertToTelegramButtons, convertMarkdownToTelegram } from './utils';
import { PromptManager } from './promptManager';

import fs from 'node:fs';

/**
 * Enum representing different types of media.
 * @enum { string }
 * @readonly
 */
export enum MediaType {
  PHOTO = 'photo',
  VIDEO = 'video',
  DOCUMENT = 'document',
  AUDIO = 'audio',
  ANIMATION = 'animation',
}

const MAX_MESSAGE_LENGTH = 4096; // Telegram's max message length

const getChannelType = (chat: Chat): ChannelType => {
  // Use a switch statement for clarity and exhaustive checks
  switch (chat.type) {
    case 'private':
      return ChannelType.DM;
    case 'group':
    case 'supergroup':
    case 'channel':
      return ChannelType.GROUP;
    default:
      throw new Error(`Unrecognized Telegram chat type: ${(chat as any).type}`);
  }
};

/**
 * Class representing a message manager.
 * @class
 */
export class MessageManager {
  public bot: Telegraf<Context>;
  protected runtime: IAgentRuntime;
  private promptManager: PromptManager;

  /**
   * Constructor for creating a new instance of a BotAgent.
   *
   * @param {Telegraf<Context>} bot - The Telegraf instance used for interacting with the bot platform.
   * @param {IAgentRuntime} runtime - The runtime environment for the agent.
   */
  constructor(bot: Telegraf<Context>, runtime: IAgentRuntime) {
    this.bot = bot;
    this.runtime = runtime;
    this.promptManager = new PromptManager(runtime);
  }

  // Process image messages and generate descriptions
  /**
   * Process an image from a Telegram message to extract the image URL and description.
   *
   * @param {Message} message - The Telegram message object containing the image.
   * @returns {Promise<{ description: string } | null>} The description of the processed image or null if no image found.
   */
  async processImage(message: Message): Promise<{ description: string } | null> {
    try {
      let imageUrl: string | null = null;

      logger.info(`Telegram Message: ${JSON.stringify(message, null, 2)}`);

      if ('photo' in message && message.photo?.length > 0) {
        const photo = message.photo[message.photo.length - 1];
        const fileLink = await this.bot.telegram.getFileLink(photo.file_id);
        imageUrl = fileLink.toString();
      } else if ('document' in message && message.document?.mime_type?.startsWith('image/')) {
        const fileLink = await this.bot.telegram.getFileLink(message.document.file_id);
        imageUrl = fileLink.toString();
      }

      if (imageUrl) {
        const { title, description } = await this.runtime.useModel(
          ModelType.IMAGE_DESCRIPTION,
          imageUrl
        );
        return { description: `[Image: ${title}\n${description}]` };
      }
    } catch (error) {
      console.error('❌ Error processing image:', error);
    }

    return null;
  }

  /**
   * Process a voice message and return the transcription
   * @param message The Telegram message containing voice data
   * @returns Promise<string | null> The transcribed text or null if processing failed
   */
  async processVoiceMessage(message: Message): Promise<string | null> {
    try {
      // Check for voice message
      if (!('voice' in message) || !message.voice) {
        return null;
      }

      const audioInfo = message.voice;
      logger.info('Processing voice message:', audioInfo);

      // Get the file path
      const file = await this.bot.telegram.getFile(audioInfo.file_id);
      if (!file.file_path) {
        logger.error('Could not get file path for voice message');
        return null;
      }

      // Get the download URL
      const downloadUrl = `https://api.telegram.org/file/bot${this.runtime.getSetting('TELEGRAM_BOT_TOKEN')}/${file.file_path}`;

      try {
        // Download the audio file
        const response = await fetch(downloadUrl);
        if (!response.ok) {
          throw new Error(`Failed to download audio file: ${response.statusText}`);
        }

        // Convert the audio data to a buffer
        const audioBuffer = Buffer.from(await response.arrayBuffer());

        // Use the runtime's built-in transcription capability
        const transcription = await this.runtime.useModel(ModelType.TRANSCRIPTION, audioBuffer);
        logger.info('Transcription:', transcription);
        if (!transcription) {
          logger.error('Failed to transcribe voice message - no transcription returned');
          return null;
        }

        logger.info('Voice message transcribed successfully:', transcription);
        return transcription;
      } catch (error) {
        logger.error('Error downloading or transcribing audio:', error);
        return null;
      }
    } catch (error) {
      logger.error('Error in processVoiceMessage:', error);
      return null;
    }
  }

  // Send long messages in chunks
  /**
   * Sends a message in chunks, handling attachments and splitting the message if necessary
   *
   * @param {Context} ctx - The context object representing the current state of the bot
   * @param {TelegramContent} content - The content of the message to be sent
   * @param {number} [replyToMessageId] - The ID of the message to reply to, if any
   * @returns {Promise<Message.TextMessage[]>} - An array of TextMessage objects representing the messages sent
   */
  async sendMessageInChunks(
    ctx: Context,
    content: TelegramContent,
    replyToMessageId?: number
  ): Promise<Message.TextMessage[]> {
    if (content.attachments && content.attachments.length > 0) {
      content.attachments.map(async (attachment: Media) => {
        const typeMap: { [key: string]: MediaType } = {
          'image/gif': MediaType.ANIMATION,
          image: MediaType.PHOTO,
          doc: MediaType.DOCUMENT,
          video: MediaType.VIDEO,
          audio: MediaType.AUDIO,
        };

        let mediaType: MediaType | undefined = undefined;

        for (const prefix in typeMap) {
          if (attachment.contentType?.startsWith(prefix)) {
            mediaType = typeMap[prefix];
            break;
          }
        }

        if (!mediaType) {
          throw new Error(
            `Unsupported Telegram attachment content type: ${attachment.contentType}`
          );
        }

        await this.sendMedia(ctx, attachment.url, mediaType, attachment.description);
      });
      return [];
    } else {
      const chunks = this.splitMessage(content.text ?? '');
      const sentMessages: Message.TextMessage[] = [];

      const buttons = ((content.buttons as unknown as Button[]) ?? []).map((btn) =>
        btn.kind === 'login'
          ? Markup.button.login(btn.text, btn.url)
          : Markup.button.url(btn.text, btn.url)
      );

      if (!ctx.chat) {
        logger.error('sendMessageInChunks: ctx.chat is undefined');
        return [];
      }
      await ctx.telegram.sendChatAction(ctx.chat.id, 'typing');

      for (let i = 0; i < chunks.length; i++) {
        const chunk = convertMarkdownToTelegram(chunks[i]);
        if (!ctx.chat) {
          logger.error('sendMessageInChunks loop: ctx.chat is undefined');
          continue;
        }
        const markup = buttons.length > 0 ? Markup.inlineKeyboard([buttons]) : undefined;
        const sentMessage = (await ctx.telegram.sendMessage(ctx.chat.id, chunk, {
          reply_parameters:
            i === 0 && replyToMessageId ? { message_id: replyToMessageId } : undefined,
          parse_mode: 'MarkdownV2',
          reply_markup: markup?.reply_markup,
        })) as Message.TextMessage;

        sentMessages.push(sentMessage);
      }

      return sentMessages;
    }
  }

  /**
   * Sends media to a chat using the Telegram API.
   *
   * @param {Context} ctx - The context object containing information about the current chat.
   * @param {string} mediaPath - The path to the media to be sent, either a URL or a local file path.
   * @param {MediaType} type - The type of media being sent (PHOTO, VIDEO, DOCUMENT, AUDIO, or ANIMATION).
   * @param {string} [caption] - Optional caption for the media being sent.
   *
   * @returns {Promise<void>} A Promise that resolves when the media is successfully sent.
   */
  async sendMedia(
    ctx: Context,
    mediaPath: string,
    type: MediaType,
    caption?: string
  ): Promise<void> {
    try {
      const isUrl = /^(http|https):\/\//.test(mediaPath);
      const sendFunctionMap: Record<MediaType, Function> = {
        [MediaType.PHOTO]: ctx.telegram.sendPhoto.bind(ctx.telegram),
        [MediaType.VIDEO]: ctx.telegram.sendVideo.bind(ctx.telegram),
        [MediaType.DOCUMENT]: ctx.telegram.sendDocument.bind(ctx.telegram),
        [MediaType.AUDIO]: ctx.telegram.sendAudio.bind(ctx.telegram),
        [MediaType.ANIMATION]: ctx.telegram.sendAnimation.bind(ctx.telegram),
      };

      const sendFunction = sendFunctionMap[type];

      if (!sendFunction) {
        throw new Error(`Unsupported media type: ${type}`);
      }

      if (!ctx.chat) {
        throw new Error('sendMedia: ctx.chat is undefined');
      }

      if (isUrl) {
        // Handle HTTP URLs
        await sendFunction(ctx.chat.id, mediaPath, { caption });
      } else {
        // Handle local file paths
        if (!fs.existsSync(mediaPath)) {
          throw new Error(`File not found at path: ${mediaPath}`);
        }

        const fileStream = fs.createReadStream(mediaPath);

        try {
          if (!ctx.chat) {
            throw new Error('sendMedia (file): ctx.chat is undefined');
          }
          await sendFunction(ctx.chat.id, { source: fileStream }, { caption });
        } finally {
          fileStream.destroy();
        }
      }

      logger.info(
        `${type.charAt(0).toUpperCase() + type.slice(1)} sent successfully: ${mediaPath}`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to send ${type}. Path: ${mediaPath}. Error: ${errorMessage}`, {
        originalError: error,
      });
      throw error;
    }
  }

  // Split message into smaller parts
  /**
   * Splits a given text into an array of strings based on the maximum message length.
   *
   * @param {string} text - The text to split into chunks.
   * @returns {string[]} An array of strings with each element representing a chunk of the original text.
   */
  private splitMessage(text: string): string[] {
    const chunks: string[] = [];
    if (!text) return chunks;
    let currentChunk = '';

    const lines = text.split('\n');
    for (const line of lines) {
      if (currentChunk.length + line.length + 1 <= MAX_MESSAGE_LENGTH) {
        currentChunk += (currentChunk ? '\n' : '') + line;
      } else {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = line;
      }
    }

    if (currentChunk) chunks.push(currentChunk);
    return chunks;
  }

  // Main handler for incoming messages
  /**
   * Handle incoming messages from Telegram and process them accordingly.
   * @param {Context} ctx - The context object containing information about the message.
   * @returns {Promise<void>}
   */
  public async handleMessage(ctx: Context): Promise<void> {
    try {
      logger.info('handleMessage: ctx:', ctx);
      if (!ctx.message || !ctx.from) return;
      const message = ctx.message;

      let messageText = '';
      let messageType = 'text';

      // Process voice message
      if ('voice' in message && message.voice) {
        const voiceTranscription = await this.processVoiceMessage(message);
        logger.info('Voice transcription:', voiceTranscription);
        if (voiceTranscription) {
          messageText = voiceTranscription;
          messageType = 'voice';
          logger.info('Using voice transcription as message text:', messageText);
        } else {
          logger.error('Failed to process voice message');
          return;
        }
      } else if ('text' in message && message.text) {
        messageText = message.text;
      } else if ('caption' in message && message.caption) {
        messageText = message.caption;
      } else {
        logger.debug('Message has no text content');
        return;
      }

      logger.info('Processing message:', { text: messageText, type: messageType });

      // Check if this is a prompt update request
      if (this.promptManager.isPromptUpdateRequest(messageText)) {
        logger.info('Handling prompt update request');
        await this.promptManager.handlePromptUpdate(ctx);
        return;
      }

      // Check if this is an edited prompt
      if (messageText.startsWith('EDIT:')) {
        logger.info('Handling edited prompt');
        await this.promptManager.handleEditedPrompt(ctx, messageText);
        return;
      }

      // Convert IDs to UUIDs
      const entityId = createUniqueUuid(this.runtime, ctx.from.id.toString()) as UUID;

      const threadId =
        'is_topic_message' in message && message.is_topic_message
          ? message.message_thread_id?.toString()
          : undefined;

      // Add null check for ctx.chat
      if (!ctx.chat) {
        logger.error('handleMessage: ctx.chat is undefined');
        return;
      }
      // Generate room ID based on whether this is in a forum topic
      const telegramRoomid = threadId ? `${ctx.chat.id}-${threadId}` : ctx.chat.id.toString();
      const roomId = createUniqueUuid(this.runtime, telegramRoomid) as UUID;

      // Get message ID (unique to channel)
      const messageId = createUniqueUuid(this.runtime, message?.message_id?.toString());

      // Handle images
      const imageInfo = await this.processImage(message);

      // Combine text and image description
      const fullText = imageInfo ? `${messageText} ${imageInfo.description}` : messageText;
      if (!fullText) return;

      // Get chat type and determine channel type
      const chat = message.chat as Chat;
      const channelType = getChannelType(chat);

      await this.runtime.ensureConnection({
        entityId,
        roomId,
        userName: ctx.from.username,
        name: ctx.from.first_name,
        source: 'telegram',
        channelId: telegramRoomid,
        serverId: undefined,
        type: channelType,
        worldId: createUniqueUuid(this.runtime, roomId) as UUID,
        worldName: telegramRoomid,
      });

      // Create the memory object
      const memory: Memory = {
        id: messageId,
        entityId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
          text: fullText,
          source: 'telegram',
          channelType: channelType,
          inReplyTo:
            'reply_to_message' in message && message.reply_to_message
              ? createUniqueUuid(this.runtime, message.reply_to_message.message_id.toString())
              : undefined,
        },
        metadata: {
          entityName: ctx.from.first_name,
          entityUserName: ctx.from.username,
          fromBot: ctx.from.is_bot,
          fromId: chat.id,
          type: 'message',
        },
        createdAt: message.date * 1000,
      };

      // Create callback for handling responses
      const callback: HandlerCallback = async (content: Content, _files?: string[]) => {
        try {
          // If response is from reasoning do not send it.
          if (!content.text) return [];

          let sentMessages: boolean | Message.TextMessage[] = false;
          if (content?.target === 'DM') {
            sentMessages = [];
            if (ctx.from) {
              // FIXME split on 4096 chars
              const res = await this.bot.telegram.sendMessage(ctx.from.id, content.text);
              sentMessages.push(res);
            }
          } else {
            sentMessages = await this.sendMessageInChunks(
              ctx,
              content as TelegramContent,
              message.message_id
            );
          }

          if (!Array.isArray(sentMessages)) return [];

          const memories: Memory[] = [];
          for (let i = 0; i < sentMessages.length; i++) {
            const sentMessage = sentMessages[i];
            const _isLastMessage = i === sentMessages.length - 1;

            const responseMemory: Memory = {
              id: createUniqueUuid(this.runtime, sentMessage.message_id.toString()),
              entityId: this.runtime.agentId,
              agentId: this.runtime.agentId,
              roomId,
              content: {
                ...content,
                source: 'telegram',
                text: sentMessage.text,
                inReplyTo: messageId,
                channelType: channelType,
              },
              createdAt: sentMessage.date * 1000,
            };

            await this.runtime.createMemory(responseMemory, 'messages');
            memories.push(responseMemory);
          }

          return memories;
        } catch (error) {
          logger.error('Error in message callback:', error);
          return [];
        }
      };

      // Let the bootstrap plugin handle the message
      this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        callback,
        source: 'telegram',
      });

      // Also emit the platform-specific event
      this.runtime.emitEvent(TelegramEventTypes.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        callback,
        source: 'telegram',
        ctx,
        originalMessage: message,
      } as TelegramMessageReceivedPayload);
    } catch (error) {
      logger.error('Error handling Telegram message:', {
        error,
        chatId: ctx.chat?.id,
        messageId: ctx.message?.message_id,
        from: ctx.from?.username || ctx.from?.id,
      });
      throw error;
    }
  }

  // Add method to handle callback queries for prompt updates
  public async handleCallbackQuery(ctx: Context): Promise<void> {
    try {
      if (!ctx.callbackQuery) return;

      const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : null;
      if (!data) return;

      // Check if this is a prompt-related callback
      if (
        data.startsWith('apply_prompt:') ||
        data === 'dismiss_prompt' ||
        data.startsWith('edit_prompt:') ||
        data === 'another_prompt'
      ) {
        await this.promptManager.handlePromptCallback(ctx);
        return;
      }

      // Handle other callback queries here if needed
    } catch (error) {
      logger.error('Error handling callback query:', error);
      await ctx.reply('Sorry, I encountered an error while processing your request.');
    }
  }

  /**
   * Handles the reaction event triggered by a user reacting to a message.
   * @param {NarrowedContext<Context<Update>, Update.MessageReactionUpdate>} ctx The context of the message reaction update
   * @returns {Promise<void>} A Promise that resolves when the reaction handling is complete
   */
  public async handleReaction(
    ctx: NarrowedContext<Context<Update>, Update.MessageReactionUpdate>
  ): Promise<void> {
    // Ensure we have the necessary data
    if (!ctx.update.message_reaction || !ctx.from) return;

    const reaction = ctx.update.message_reaction;
    const reactedToMessageId = reaction.message_id;

    const originalMessagePlaceholder: Partial<Message> = {
      message_id: reactedToMessageId,
      chat: reaction.chat,
      from: ctx.from,
      date: Math.floor(Date.now() / 1000),
    };

    const reactionType = reaction.new_reaction[0].type;
    const reactionEmoji = (reaction.new_reaction[0] as ReactionType).type; // Assuming ReactionType has 'type' for emoji

    try {
      const entityId = createUniqueUuid(this.runtime, ctx.from.id.toString()) as UUID;
      const roomId = createUniqueUuid(this.runtime, ctx.chat.id.toString());

      const reactionId = createUniqueUuid(
        this.runtime,
        `${reaction.message_id}-${ctx.from.id}-${Date.now()}`
      );

      // Create reaction memory
      const memory: Memory = {
        id: reactionId,
        entityId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
          channelType: getChannelType(reaction.chat as Chat),
          text: `Reacted with: ${reactionType === 'emoji' ? reactionEmoji : reactionType}`,
          source: 'telegram',
          inReplyTo: createUniqueUuid(this.runtime, reaction.message_id.toString()),
        },
        createdAt: Date.now(),
      };

      // Create callback for handling reaction responses
      const callback: HandlerCallback = async (content: Content) => {
        try {
          // Add null check for content.text
          const replyText = content.text ?? '';
          const sentMessage = await ctx.reply(replyText);
          const responseMemory: Memory = {
            id: createUniqueUuid(this.runtime, sentMessage.message_id.toString()),
            entityId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            roomId,
            content: {
              ...content,
              inReplyTo: reactionId,
            },
            createdAt: sentMessage.date * 1000,
          };
          return [responseMemory];
        } catch (error) {
          logger.error('Error in reaction callback:', error);
          return [];
        }
      };

      // Let the bootstrap plugin handle the reaction
      this.runtime.emitEvent(EventType.REACTION_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        callback,
        source: 'telegram',
        ctx,
        originalMessage: originalMessagePlaceholder as Message, // Cast needed due to placeholder
        reactionString: reactionType === 'emoji' ? reactionEmoji : reactionType,
        originalReaction: reaction.new_reaction[0] as ReactionType,
      } as TelegramReactionReceivedPayload);

      // Also emit the platform-specific event
      this.runtime.emitEvent(TelegramEventTypes.REACTION_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        callback,
        source: 'telegram',
        ctx,
        originalMessage: originalMessagePlaceholder as Message, // Cast needed due to placeholder
        reactionString: reactionType === 'emoji' ? reactionEmoji : reactionType,
        originalReaction: reaction.new_reaction[0] as ReactionType,
      } as TelegramReactionReceivedPayload);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Error handling reaction:', { error: errorMessage, originalError: error });
    }
  }

  /**
   * Sends a message to a Telegram chat and emits appropriate events
   * @param {number | string} chatId - The Telegram chat ID to send the message to
   * @param {Content} content - The content to send
   * @param {number} [replyToMessageId] - Optional message ID to reply to
   * @returns {Promise<Message.TextMessage[]>} The sent messages
   */
  public async sendMessage(
    chatId: number | string,
    content: Content,
    replyToMessageId?: number
  ): Promise<Message.TextMessage[]> {
    try {
      // Create a context-like object for sending
      const ctx = {
        chat: { id: chatId },
        telegram: this.bot.telegram,
      };

      const sentMessages = await this.sendMessageInChunks(
        ctx as Context,
        content as TelegramContent,
        replyToMessageId
      );

      if (!sentMessages?.length) return [];

      // Create group ID
      const roomId = createUniqueUuid(this.runtime, chatId.toString());

      // Create memories for the sent messages
      const memories: Memory[] = [];
      for (const sentMessage of sentMessages) {
        const memory: Memory = {
          id: createUniqueUuid(this.runtime, sentMessage.message_id.toString()),
          entityId: this.runtime.agentId,
          agentId: this.runtime.agentId,
          roomId,
          content: {
            ...content,
            text: sentMessage.text,
            source: 'telegram',
            channelType: getChannelType({
              id: typeof chatId === 'string' ? Number.parseInt(chatId, 10) : chatId,
              type: 'private', // Default to private, will be overridden if in context
            } as Chat),
          },
          createdAt: sentMessage.date * 1000,
        };

        await this.runtime.createMemory(memory, 'messages');
        memories.push(memory);
      }

      // Emit both generic and platform-specific message sent events
      this.runtime.emitEvent(EventType.MESSAGE_SENT, {
        runtime: this.runtime,
        message: {
          content: content,
        },
        roomId,
        source: 'telegram',
      });

      // Also emit platform-specific event
      this.runtime.emitEvent(TelegramEventTypes.MESSAGE_SENT, {
        originalMessages: sentMessages,
        chatId,
      } as TelegramMessageSentPayload);

      return sentMessages;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Error sending message to Telegram:', {
        error: errorMessage,
        originalError: error,
      });
      return [];
    }
  }
}
