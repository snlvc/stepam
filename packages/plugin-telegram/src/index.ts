import type { Plugin } from '@elizaos/core';
import { TELEGRAM_SERVICE_NAME } from './constants';
import { TelegramService } from './service';
import { TelegramTestSuite } from './tests';
import { MessageManager } from './messageManager';
import { updatePromptAction } from './actions/updatePrompt';

const telegramPlugin: Plugin = {
  name: TELEGRAM_SERVICE_NAME,
  description: 'Telegram client plugin',
  services: [TelegramService],
  tests: [new TelegramTestSuite()],
  actions: [updatePromptAction],
  // Set high priority to ensure our actions are checked before others
  priority: 100,
};

export { TelegramService, MessageManager };
export default telegramPlugin;
