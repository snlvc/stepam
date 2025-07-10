// src/characters/stepan.character.ts

import { Character, logger, DatabaseAdapter, Agent, AgentStatus } from '@elizaos/core';
import { configureDatabaseSettings, resolvePgliteDir } from '@/src/utils';
import { AgentServer } from '@elizaos/server';
import stepanJson from './stepan.json';

const AGENT_NAME = 'stepam'; // Using the name from JSON file

/**
 * Returns the Stepam character with plugins ordered by priority based on environment variables.
 * Gets the character from the database, falling back to local JSON if not found.
 *
 * @returns {Promise<Character>} The Stepam character with appropriate plugins for the current environment
 */
export async function getStepanCharacter(db?: DatabaseAdapter): Promise<Character> {
  try {
    logger.info('[StepanCharacter] Starting character initialization');
    const postgresUrl = process.env.POSTGRES_URL;
    console.log('postgresUrl', postgresUrl);
    if (!postgresUrl) {
      throw new Error('PostgreSQL URL is required but was not provided');
    }

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
    let agent = await dbAdapter.getAgentByName(AGENT_NAME);
    // If agent not found in database, create it from local JSON file
    if (!agent) {
      logger.info('[StepanCharacter] Agent not found in database, creating from local JSON file');
      const now = Date.now();
      const newAgent = {
        ...stepanJson,
        createdAt: now,
        updatedAt: now,
        status: AgentStatus.ACTIVE,
        enabled: true,
      } as Agent;

      await dbAdapter.createAgent(newAgent);
      agent = await dbAdapter.getAgentByName(AGENT_NAME);
      if (!agent) {
        throw new Error('Failed to retrieve newly created agent');
      }

      logger.info('[StepanCharacter] Successfully created agent in database');
    } else {
      logger.info('[StepanCharacter] Found agent in runtime');
    }

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
      id: agent.id, // Use the existing agent ID
      name: agent.name,
      username: agent.username || null,
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
