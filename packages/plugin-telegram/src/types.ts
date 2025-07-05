import {
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type Service,
  type UUID,
  type Media,
  ChannelType,
  type MessagePayload,
  type WorldPayload,
  type EntityPayload,
} from '@elizaos/core';
import { type Context } from 'telegraf';
import { type Message, type Chat, type ReactionType } from '@telegraf/types';

export interface TelegramButton {
  text: string;
  callback_data: string;
}

export interface TelegramContent extends Content {
  text?: string;
  attachments?: Media[];
  buttons?: TelegramButton[][];
  source: 'telegram';
  channelType?: ChannelType;
  inReplyTo?: UUID;
  isCommand?: boolean;
}

/**
 * Represents a flexible button configuration
 */
export type Button = {
  /** The type of button */
  kind: 'login' | 'url';
  /** The text to display on the button */
  text: string;
  /** The URL or endpoint the button should link to */
  url: string;
};

/**
 * Telegram-specific event types
 */
export enum TelegramEventTypes {
  // World events
  WORLD_JOINED = 'telegram:world_joined',
  WORLD_CONNECTED = 'telegram:world_connected',
  WORLD_LEFT = 'telegram:world_left',

  // Entity events
  ENTITY_JOINED = 'telegram:entity_joined',
  ENTITY_LEFT = 'telegram:entity_left',
  ENTITY_UPDATED = 'telegram:entity_updated',

  // Message events
  MESSAGE_RECEIVED = 'telegram:message_received',
  MESSAGE_SENT = 'telegram:message_sent',

  // Interaction events
  REACTION_RECEIVED = 'telegram:reaction_received',
  INTERACTION_RECEIVED = 'telegram:interaction_received',
}

/**
 * Telegram-specific message received payload
 */
export interface TelegramMessageReceivedPayload extends MessagePayload {
  /** The original Telegram context */
  ctx: Context;
  /** The original Telegram message */
  originalMessage: Message;
  /** Whether this is a command message */
  isCommand?: boolean;
}

/**
 * Telegram-specific message sent payload
 */
export interface TelegramMessageSentPayload extends MessagePayload {
  /** The original Telegram messages */
  originalMessages: Message[];
  /** The chat ID the message was sent to */
  chatId: number | string;
}

/**
 * Telegram-specific reaction received payload
 */
export interface TelegramReactionReceivedPayload extends MessagePayload {
  /** The original Telegram context */
  ctx: Context;
  /** The original message that was reacted to */
  originalMessage: Message;
  /** The reaction string representation */
  reactionString: string;
  /** The original reaction object */
  originalReaction: ReactionType;
}

/**
 * Telegram-specific world payload
 */
export interface TelegramWorldPayload extends WorldPayload {
  chat: Chat;
  botUsername?: string;
}

/**
 * Telegram-specific entity payload
 */
export interface TelegramEntityPayload extends EntityPayload {
  telegramUser: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
}

/**
 * Maps Telegram event types to their corresponding payload types
 */
export interface TelegramEventPayloadMap {
  [TelegramEventTypes.MESSAGE_RECEIVED]: TelegramMessageReceivedPayload;
  [TelegramEventTypes.MESSAGE_SENT]: TelegramMessageSentPayload;
  [TelegramEventTypes.REACTION_RECEIVED]: TelegramReactionReceivedPayload;
  [TelegramEventTypes.WORLD_JOINED]: TelegramWorldPayload;
  [TelegramEventTypes.WORLD_CONNECTED]: TelegramWorldPayload;
  [TelegramEventTypes.WORLD_LEFT]: TelegramWorldPayload;
  [TelegramEventTypes.ENTITY_JOINED]: TelegramEntityPayload;
  [TelegramEventTypes.ENTITY_LEFT]: TelegramEntityPayload;
  [TelegramEventTypes.ENTITY_UPDATED]: TelegramEntityPayload;
  [TelegramEventTypes.INTERACTION_RECEIVED]: TelegramReactionReceivedPayload;
}
