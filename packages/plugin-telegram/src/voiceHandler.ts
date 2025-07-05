import { type IAgentRuntime, logger } from '@elizaos/core';
import type { Context } from 'telegraf';
import { type Message } from '@telegraf/types';
import { createWriteStream, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import OpenAI from 'openai';

export class VoiceHandler {
  private runtime: IAgentRuntime;
  private openai: OpenAI | null = null;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    const apiKey = runtime.getSetting('OPENAI_API_KEY');
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
    }
  }

  /**
   * Downloads a voice message from Telegram and saves it locally
   */
  private async downloadVoiceMessage(ctx: Context, message: Message.VoiceMessage): Promise<string> {
    try {
      const file = await ctx.telegram.getFile(message.voice.file_id);
      if (!file.file_path) {
        throw new Error('No file path in voice message');
      }

      // Create a temporary file path
      const tempFilePath = join(tmpdir(), `voice_${Date.now()}.oga`);

      // Get the file URL
      const fileUrl = `https://api.telegram.org/file/bot${this.runtime.getSetting('TELEGRAM_BOT_TOKEN')}/${file.file_path}`;

      // Download the file
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download voice message: ${response.statusText}`);
      }

      // Save the file
      const fileStream = createWriteStream(tempFilePath);
      await pipeline(response.body as any, fileStream);

      logger.info(`Voice message downloaded to ${tempFilePath}`);
      return tempFilePath;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error downloading voice message: ${errorMessage}`, { originalError: error });
      throw error;
    }
  }

  /**
   * Transcribes a voice message using OpenAI's Whisper API
   */
  private async transcribeVoiceMessage(filePath: string): Promise<string> {
    try {
      if (!this.openai) {
        throw new Error('OpenAI API key not configured. Voice messages cannot be transcribed.');
      }

      const transcription = await this.openai.audio.transcriptions.create({
        file: createReadStream(filePath),
        model: 'whisper-1',
      });

      logger.info('Voice message transcribed successfully');
      return transcription.text;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error transcribing voice message: ${errorMessage}`, { originalError: error });
      throw error;
    }
  }

  /**
   * Handles a voice message by downloading it and transcribing it
   */
  public async handleVoiceMessage(ctx: Context, message: Message.VoiceMessage): Promise<string> {
    try {
      // Download the voice message
      const filePath = await this.downloadVoiceMessage(ctx, message);

      // Try to transcribe if OpenAI is configured
      try {
        const transcription = await this.transcribeVoiceMessage(filePath);
        return transcription;
      } catch (error) {
        if (error instanceof Error && error.message.includes('OpenAI API key not configured')) {
          return '[Voice Message] - Transcription not available (OpenAI API key not configured)';
        }
        throw error;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error handling voice message: ${errorMessage}`, { originalError: error });
      throw error;
    }
  }
}
