// src/characters/stepan.character.ts

import { Character, logger, DatabaseAdapter } from '@elizaos/core';
import { configureDatabaseSettings, resolvePgliteDir } from '@/src/utils';
import { AgentServer } from '@elizaos/server';

const AGENT_NAME = 'stepam'; // Using the name from JSON file

/**
 * Returns the Stepam character with plugins ordered by priority based on environment variables.
 * Gets the character from the database.
 *
 * @returns {Promise<Character>} The Stepam character with appropriate plugins for the current environment
 */
export async function getStepanCharacter(db?: DatabaseAdapter): Promise<Character> {
  try {
    logger.info('[StepanCharacter] Starting character initialization');

    // Configure database settings
    const postgresUrl = await configureDatabaseSettings();
    if (!postgresUrl) {
      throw new Error('PostgreSQL URL is required but was not provided');
    }
    process.env.POSTGRES_URL = postgresUrl;

    // If no database adapter provided, create one through AgentServer
    let dbAdapter = db;
    console.log('dbAdapter', dbAdapter);
    if (!dbAdapter) {
      const pgliteDataDir = postgresUrl ? undefined : await resolvePgliteDir();
      const server = new AgentServer();
      await server.initialize({ dataDir: pgliteDataDir, postgresUrl: postgresUrl || undefined });
      dbAdapter = (server as any).database as DatabaseAdapter;
    }

    const isReady = await dbAdapter.isReady();
    if (!isReady) {
      throw new Error(
        'Database is not ready. Please ensure database connection is properly initialized'
      );
    }

    // Get agent by name
    const agent = await dbAdapter.getAgentByName(AGENT_NAME);

    if (!agent) {
      throw new Error(`Agent ${AGENT_NAME} not found in database`);
    }

    logger.info('[StepanCharacter] Found agent in runtime');

    // Update plugins based on environment
    const plugins = [
      '@elizaos/plugin-sql',
      '@elizaos/plugin-bootstrap',
      ...(process.env.OPENAI_API_KEY ? ['@elizaos/plugin-openai'] : []),
      ...(process.env.TELEGRAM_BOT_TOKEN ? ['@elizaos/plugin-telegram'] : []),
    ];

    // Return enhanced character with plugins and context
    return {
      ...agent,
      name: agent.name,
      username: '123',
      bio: agent.bio || null,
      system: agent.system || null,
      style: agent.style || null,
      topics: agent.topics || null,
      adjectives: agent.adjectives || null,
      knowledge: agent.knowledge || null,
      messageExamples: agent.messageExamples || null,
      postExamples: agent.postExamples || null,
      core_readings: agent.core_readings || null,
      settings: agent.settings,
      plugins,
      secrets: {
        key: process.env.TELEGRAM_BOT_TOKEN || '',
      },
    } as Character;
  } catch (error) {
    logger.error('[StepanCharacter] Failed to get character:', error);
    throw error;
  }
}

// Initialize character
let characterPromise: Promise<Character>;
export const character: Character = await (characterPromise = getStepanCharacter());
