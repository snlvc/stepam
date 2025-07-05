import {
  Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  logger,
  type Service,
  type UUID,
  createUniqueUuid,
  ChannelType,
} from '@elizaos/core';
import { type Context } from 'telegraf';
import { type Message, type Update } from '@telegraf/types';
import { Markup } from 'telegraf';
import {
  TelegramEventTypes,
  type TelegramMessageReceivedPayload,
  type TelegramContent,
} from '../types';
import { TelegramService } from '../service';

// Add namespace to logger for update prompt actions
const updatePromptLogger = logger.child({ source: 'telegram', component: 'UpdatePromptAction' });

interface UpdatePromptState {
  newPrompt?: string;
  messageId?: number;
  stage: 'initial' | 'awaiting_confirmation' | 'awaiting_custom_prompt';
}

interface DatabaseService extends Service {
  query(sql: string, params: any[]): Promise<{ rows: any[] }>;
}

export const updatePromptAction: Action = {
  name: 'UPDATE_PROMPT',
  description: 'Handles the prompt update flow via Telegram',
  similes: ['UPDATE_CHARACTER', 'CHANGE_PROMPT', 'MODIFY_PROMPT', 'EDIT_PROMPT'],
  validate: async (runtime, message, state) => {
    updatePromptLogger.info('Starting validation with message:', {
      source: message.content.source,
      text: message.content.text,
      state: state,
      messageId: message.id,
      entityId: message.entityId,
      roomId: message.roomId,
    });

    // Only handle Telegram messages
    if (message.content.source !== 'telegram') {
      updatePromptLogger.debug('Skipping - not a telegram message');
      return false;
    }

    // Check if we have text content
    const text = message.content.text?.toLowerCase().trim();
    if (!text) {
      updatePromptLogger.debug('Skipping - no text content');
      return false;
    }

    // Check if we're in the custom prompt stage
    const isInCustomPromptStage = state?.stage === 'awaiting_custom_prompt';
    if (isInCustomPromptStage) {
      updatePromptLogger.info('In custom prompt stage, validating');
      return true;
    }

    // Check for exact command match
    if (text === '/update_prompt') {
      updatePromptLogger.info('Exact command match found');
      return true;
    }

    // If this is a command message but not /update_prompt, skip it
    if (message.content.isCommand) {
      updatePromptLogger.debug('Skipping - different command');
      return false;
    }

    // Natural language triggers
    const naturalTriggers = [
      // English variations
      "let's update your prompt",
      "let's update your character",
      "let's change your prompt",
      "let's change your character",
      "let's modify your prompt",
      "let's modify your character",
      'update your prompt',
      'update your character',
      'change your prompt',
      'change your character',
      'modify your prompt',
      'modify your character',
      'i want to update your prompt',
      'i want to update your character',
      'i want to change your prompt',
      'i want to change your character',
      'can we update your prompt',
      'can we update your character',
      'can you update your prompt',
      'can you update your character',
      // Russian variations
      'давай обновим твой характер',
      'давай обновим тебя',
      'давай обновим твой промпт',
      'давай изменим твой характер',
      'давай изменим тебя',
      'давай изменим твой промпт',
      'обнови свой характер',
      'обнови свой промпт',
      'измени свой характер',
      'измени свой промпт',
      'хочу обновить твой характер',
      'хочу обновить твой промпт',
      'можно обновить твой характер',
      'можно обновить твой промпт',
    ];

    // Check for natural language triggers with more flexible matching
    const matchesNaturalTrigger = naturalTriggers.some((trigger) => {
      const normalizedTrigger = trigger
        .toLowerCase()
        .replace(/[.,!?]/g, '')
        .trim();
      const normalizedText = text
        .toLowerCase()
        .replace(/[.,!?]/g, '')
        .trim();
      return normalizedText.includes(normalizedTrigger);
    });

    if (matchesNaturalTrigger) {
      updatePromptLogger.info('Natural language trigger match found');
      return true;
    }

    updatePromptLogger.debug('No matches found, skipping');
    return false;
  },

  handler: async (runtime, message, state, _options, callback): Promise<boolean> => {
    if (!callback) {
      updatePromptLogger.error('No callback provided');
      return false;
    }

    try {
      // Get the Telegram service
      const telegramService = runtime.getService<TelegramService>('telegram');
      if (!telegramService) {
        updatePromptLogger.error('Telegram service not available');
        throw new Error('Telegram service not available');
      }

      const currentState = (state || {}) as UpdatePromptState;

      // Initialize state if not exists
      if (!currentState.stage) {
        currentState.stage = 'initial';
      }

      updatePromptLogger.info('Current state:', {
        stage: currentState.stage,
        messageId: currentState.messageId,
        newPrompt: currentState.newPrompt ? 'exists' : 'not set',
      });

      // If we're in custom prompt stage, handle the new prompt
      if (currentState.stage === 'awaiting_custom_prompt' && message.content.text) {
        updatePromptLogger.info('Handling custom prompt update');
        // Update the prompt in the database
        await updatePromptInDb(runtime, message.content.text);
        await callback({
          text: 'Prompt updated successfully! I will use this new character definition in our future interactions.',
          source: 'telegram',
        });
        currentState.stage = 'initial';
        return true;
      }

      // Get current prompt from the database
      const currentPrompt = await getCurrentPrompt(runtime);
      updatePromptLogger.info('Retrieved current prompt:', {
        promptLength: currentPrompt.length,
        promptPreview: currentPrompt.substring(0, 100) + '...',
      });

      // Create inline keyboard markup
      const inlineKeyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Yes', 'confirm_prompt'),
          Markup.button.callback('❌ No', 'cancel_prompt'),
        ],
        [Markup.button.callback('📝 Edit', 'edit_prompt')],
      ]);

      // Send message with inline buttons
      const content: Content = {
        text: `Current prompt:\n\n${currentPrompt}\n\nWould you like to update it?`,
        source: 'telegram',
        buttons: [
          [
            { text: '✅ Yes', callback_data: 'confirm_prompt' },
            { text: '❌ No', callback_data: 'cancel_prompt' },
          ],
          [{ text: '📝 Edit', callback_data: 'edit_prompt' }],
        ],
      };

      updatePromptLogger.info('Sending prompt update message with buttons');
      const result = await callback(content);
      updatePromptLogger.info('Callback result:', { result });

      // Update state
      currentState.stage = 'awaiting_confirmation';
      currentState.newPrompt = currentPrompt;

      return true;
    } catch (error) {
      updatePromptLogger.error('Error in updatePromptAction:', error);
      callback({
        text: 'Sorry, there was an error processing your request. Please try again.',
        source: 'telegram',
      });
      return false;
    }
  },
};

async function getCurrentPrompt(runtime: IAgentRuntime): Promise<string> {
  try {
    const db = await runtime.getService<DatabaseService>('database');
    if (!db) {
      updatePromptLogger.error('Database service not available');
      throw new Error('Database service not available');
    }
    const result = await db.query('SELECT prompt FROM agents WHERE id = $1', [runtime.agentId]);
    updatePromptLogger.info('Database query result:', {
      hasRows: result.rows.length > 0,
      agentId: runtime.agentId,
    });
    return result.rows[0]?.prompt || '';
  } catch (error) {
    updatePromptLogger.error('Error getting current prompt:', error);
    throw error;
  }
}

async function updatePromptInDb(runtime: IAgentRuntime, newPrompt: string): Promise<void> {
  try {
    const db = await runtime.getService<DatabaseService>('database');
    if (!db) {
      updatePromptLogger.error('Database service not available for update');
      throw new Error('Database service not available');
    }
    await db.query('UPDATE agents SET prompt = $1, updated_at = NOW() WHERE id = $2', [
      newPrompt,
      runtime.agentId,
    ]);
    updatePromptLogger.info('Prompt updated in database successfully');
  } catch (error) {
    updatePromptLogger.error('Error updating prompt in database:', error);
    throw error;
  }
}

/**
 * Handles the /update_prompt command from Telegram
 * @param ctx The Telegram context
 * @param runtime The agent runtime
 * @returns The memory object for the command
 */
export async function handleUpdatePromptCommand(
  ctx: Context,
  runtime: IAgentRuntime
): Promise<Memory | null> {
  try {
    if (!ctx.message || !ctx.from || !ctx.chat) {
      updatePromptLogger.error('Missing required context properties');
      return null;
    }

    // Create memory for the command
    const memory = await createMemoryFromContext(ctx, runtime);
    if (!memory) {
      updatePromptLogger.error('Failed to create memory from context');
      return null;
    }

    return memory;
  } catch (error) {
    updatePromptLogger.error('Error in handleUpdatePromptCommand:', error);
    return null;
  }
}

// Helper function to create memory from context
export async function createMemoryFromContext(
  ctx: Context,
  runtime: IAgentRuntime
): Promise<Memory | null> {
  if (!ctx.message || !ctx.from || !ctx.chat) return null;

  const message = ctx.message;
  const entityId = createUniqueUuid(runtime, ctx.from.id.toString()) as UUID;
  const telegramRoomid = ctx.chat.id.toString();
  const roomId = createUniqueUuid(runtime, telegramRoomid) as UUID;
  const messageId = createUniqueUuid(runtime, message.message_id.toString());

  const content: TelegramContent = {
    text: 'text' in message ? message.text : '',
    source: 'telegram',
    channelType: getChannelType(message.chat),
    isCommand: true,
  };

  return {
    id: messageId,
    entityId,
    agentId: runtime.agentId,
    roomId,
    content,
    metadata: {
      entityName: ctx.from.first_name,
      entityUserName: ctx.from.username,
      fromBot: ctx.from.is_bot,
      fromId: message.chat.id,
      type: 'message',
    },
    createdAt: message.date * 1000,
  };
}

// Helper function to get channel type
function getChannelType(chat: any): ChannelType {
  switch (chat.type) {
    case 'private':
      return ChannelType.DM;
    case 'group':
    case 'supergroup':
    case 'channel':
      return ChannelType.GROUP;
    default:
      throw new Error(`Unrecognized Telegram chat type: ${chat.type}`);
  }
}
