// Telegram Voice Message Patch for ElizaOS
// This patch adds automatic voice message transcription to Telegram plugin

const fs = require('fs');
const path = require('path');

const TELEGRAM_PLUGIN_PATH = path.join(__dirname, 'node_modules/@elizaos/plugin-telegram/dist/index.js');

// Voice message processing function
const voiceProcessingCode = `
  // Process voice message
  async processVoiceMessage(message) {
    try {
      let audioBuffer = null;
      let audioInfo = null;
      
      // Check for voice message
      if ("voice" in message && message.voice) {
        audioInfo = message.voice;
        logger.info("Processing voice message:", audioInfo);
      }
      // Check for audio file
      else if ("audio" in message && message.audio) {
        audioInfo = message.audio;
        logger.info("Processing audio message:", audioInfo);
      }
      // Check for document with audio mime type
      else if ("document" in message && message.document?.mime_type?.startsWith("audio/")) {
        audioInfo = message.document;
        logger.info("Processing audio document:", audioInfo);
      }
      
      if (audioInfo) {
        try {
          // Get file link from Telegram
          const fileLink = await this.bot.telegram.getFileLink(audioInfo.file_id);
          logger.info("Got audio file link:", fileLink.toString());
          
          // Download audio file
          const response = await fetch(fileLink.toString());
          if (!response.ok) {
            throw new Error(\`Failed to download audio: \${response.statusText}\`);
          }
          
          audioBuffer = Buffer.from(await response.arrayBuffer());
          logger.info("Downloaded audio buffer, size:", audioBuffer.length);
          
          // Transcribe using ElizaOS transcription
          const transcription = await this.runtime.useModel(ModelType.TRANSCRIPTION, audioBuffer);
          logger.info("Audio transcribed:", transcription);
          
          return transcription;
        } catch (error) {
          logger.error("Error processing voice message:", error);
          return null;
        }
      }
      
      return null;
    } catch (error) {
      logger.error("Error in processVoiceMessage:", error);
      return null;
    }
  }
`;

// Modified handleMessage function that includes voice processing
const modifiedHandleMessage = `
  async handleMessage(ctx) {
    if (!ctx.message || !ctx.from) return;
    const message = ctx.message;
    try {
      const entityId = createUniqueUuid(this.runtime, ctx.from.id.toString());
      const threadId = "is_topic_message" in message && message.is_topic_message ? message.message_thread_id?.toString() : void 0;
      if (!ctx.chat) {
        logger.error("handleMessage: ctx.chat is undefined");
        return;
      }
      const roomId = createUniqueUuid(
        this.runtime,
        threadId ? \`\${ctx.chat.id}-\${threadId}\` : ctx.chat.id.toString()
      );
      const messageId = createUniqueUuid(this.runtime, message?.message_id?.toString());
      
      // Process image
      const imageInfo = await this.processImage(message);
      
      // Process voice message
      const voiceTranscription = await this.processVoiceMessage(message);
      
      let messageText = "";
      if ("text" in message && message.text) {
        messageText = message.text;
      } else if ("caption" in message && message.caption) {
        messageText = message.caption;
      } else if (voiceTranscription) {
        // Use transcription as message text
        messageText = voiceTranscription;
        logger.info("Using voice transcription as message text:", messageText);
      }
      
      const fullText = imageInfo ? \`\${messageText} \${imageInfo.description}\` : messageText;
      if (!fullText) return;
      
      const chat = message.chat;
      const channelType = getChannelType(chat);
      const memory = {
        id: messageId,
        entityId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
          text: fullText,
          channelType,
          source: "telegram",
          inReplyTo: message.reply_to_message ? createUniqueUuid(this.runtime, message.reply_to_message.message_id.toString()) : void 0
        },
        createdAt: message.date * 1e3
      };
      const callback = async (content, _files) => {
        try {
          if (!content.text) return [];
          const sentMessages = await this.sendMessageInChunks(ctx, content, message.message_id);
          if (!sentMessages) return [];
          const memories = [];
          for (let i = 0; i < sentMessages.length; i++) {
            const sentMessage = sentMessages[i];
            const _isLastMessage = i === sentMessages.length - 1;
            const responseMemory = {
              id: createUniqueUuid(this.runtime, sentMessage.message_id.toString()),
              entityId: this.runtime.agentId,
              agentId: this.runtime.agentId,
              roomId,
              content: {
                text: content.text,
                channelType,
                source: "telegram",
                inReplyTo: messageId,
                channelType
              },
              createdAt: sentMessage.date * 1e3
            };
            await this.runtime.createMemory(responseMemory, "messages");
            memories.push(responseMemory);
          }
          return memories;
        } catch (error) {
          logger.error("Error in message callback:", error);
          throw error;
        }
      };
      
      // Use correct ElizaOS event system
      await this.runtime.emitEvent(EventType2.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        callback,
      });
    } catch (error) {
      logger.error("Error handling Telegram message:", {
        error,
        chatId: ctx.chat?.id,
        messageId: ctx.message?.message_id,
        from: ctx.from?.username || ctx.from?.id
      });
      throw error;
    }
  }
`;

function applyPatch() {
  try {
    console.log('Reading Telegram plugin file...');
    let pluginContent = fs.readFileSync(TELEGRAM_PLUGIN_PATH, 'utf8');

    // Add processVoiceMessage method to MessageManager class
    const processImageIndex = pluginContent.indexOf('async processImage(message)');
    if (processImageIndex === -1) {
      throw new Error('Could not find processImage method in plugin');
    }

    // Find the end of processImage method
    let braceCount = 0;
    let startBrace = false;
    let insertIndex = processImageIndex;

    for (let i = processImageIndex; i < pluginContent.length; i++) {
      if (pluginContent[i] === '{') {
        braceCount++;
        startBrace = true;
      } else if (pluginContent[i] === '}') {
        braceCount--;
        if (startBrace && braceCount === 0) {
          insertIndex = i + 1;
          break;
        }
      }
    }

    // Insert processVoiceMessage method after processImage
    pluginContent = pluginContent.slice(0, insertIndex) +
      '\n' + voiceProcessingCode + '\n' +
      pluginContent.slice(insertIndex);

    // Replace handleMessage method
    const handleMessageRegex = /async handleMessage\(ctx\)\s*{[\s\S]*?(?=\n  [a-zA-Z]|\n}\s*\n|\n  \/\*|\nclass|\n  async [a-zA-Z])/;
    const match = pluginContent.match(handleMessageRegex);

    if (match) {
      pluginContent = pluginContent.replace(handleMessageRegex, modifiedHandleMessage);
      console.log('✅ Successfully patched handleMessage method');
    } else {
      console.log('⚠️  Could not find handleMessage method to replace');
    }

    // Add ModelType import if not present
    if (!pluginContent.includes('ModelType') && pluginContent.includes('@elizaos/core')) {
      pluginContent = pluginContent.replace(
        /import\s*{\s*([^}]*)\s*}\s*from\s*"@elizaos\/core"/,
        'import { $1, ModelType } from "@elizaos/core"'
      );
      console.log('✅ Added ModelType import');
    }

    // Create backup
    const backupPath = TELEGRAM_PLUGIN_PATH + '.backup';
    if (!fs.existsSync(backupPath)) {
      fs.writeFileSync(backupPath, fs.readFileSync(TELEGRAM_PLUGIN_PATH));
      console.log('✅ Created backup of original plugin');
    }

    // Write patched content
    fs.writeFileSync(TELEGRAM_PLUGIN_PATH, pluginContent);
    console.log('✅ Applied voice message patch to Telegram plugin');
    console.log('🎤 Voice messages will now be automatically transcribed!');

    return true;
  } catch (error) {
    console.error('❌ Error applying patch:', error);
    return false;
  }
}

function restorePatch() {
  try {
    const backupPath = TELEGRAM_PLUGIN_PATH + '.backup';
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, TELEGRAM_PLUGIN_PATH);
      console.log('✅ Restored original Telegram plugin from backup');
      return true;
    } else {
      console.log('❌ No backup found to restore');
      return false;
    }
  } catch (error) {
    console.error('❌ Error restoring patch:', error);
    return false;
  }
}

// CLI interface
if (require.main === module) {
  const action = process.argv[2];

  if (action === 'apply' || !action) {
    console.log('🎤 Applying Telegram Voice Message Patch...');
    applyPatch();
  } else if (action === 'restore') {
    console.log('🔄 Restoring original Telegram plugin...');
    restorePatch();
  } else {
    console.log('Usage:');
    console.log('  node telegram-voice-patch.js apply    - Apply voice message patch');
    console.log('  node telegram-voice-patch.js restore  - Restore original plugin');
  }
}

module.exports = { applyPatch, restorePatch }; 