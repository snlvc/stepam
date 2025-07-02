#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
const { Pool } = pkg;

// ES module dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database configuration
const DB_CONFIG = {
    user: 'postgres',
    password: 'postgres',
    host: 'localhost',
    database: 'eliza',
    port: 5432,
};

// Agent configuration
const AGENT_NAME = 'Stepan';
let AGENT_ID = null;

class TelegramImporter {
    constructor() {
        this.pool = new Pool(DB_CONFIG);
        this.importedCount = 0;
        this.skippedCount = 0;
    }

    // Generate deterministic UUID from string (same as ElizaOS)
    generateUUID(input) {
        const crypto = require('crypto');
        const hash = crypto.createHash('sha256').update(input).digest('hex');
        return [
            hash.substr(0, 8),
            hash.substr(8, 4),
            '4' + hash.substr(13, 3),
            ((parseInt(hash.substr(16, 1), 16) & 0x3) | 0x8).toString(16) + hash.substr(17, 3),
            hash.substr(20, 12)
        ].join('-');
    }

    async initializeAgent() {
        try {
            // Find or create agent
            const agentQuery = 'SELECT id FROM agents WHERE name = $1';
            const agentResult = await this.pool.query(agentQuery, [AGENT_NAME]);

            if (agentResult.rows.length > 0) {
                AGENT_ID = agentResult.rows[0].id;
                console.log(`✅ Found agent: ${AGENT_NAME} (${AGENT_ID})`);
            } else {
                console.error(`❌ Agent "${AGENT_NAME}" not found in database`);
                console.log('Please make sure the agent is running first');
                process.exit(1);
            }
        } catch (error) {
            console.error('Error initializing agent:', error);
            process.exit(1);
        }
    }

    async parseExportedChat(exportPath) {
        try {
            console.log(`📂 Reading Telegram export from: ${exportPath}`);

            if (!fs.existsSync(exportPath)) {
                throw new Error(`Export file not found: ${exportPath}`);
            }

            const data = JSON.parse(fs.readFileSync(exportPath, 'utf8'));

            if (!data.messages || !Array.isArray(data.messages)) {
                throw new Error('Invalid export format: messages array not found');
            }

            console.log(`📊 Found ${data.messages.length} messages in export`);
            return data;
        } catch (error) {
            console.error('Error parsing export:', error);
            throw error;
        }
    }

    async importMessage(message, chatId, chatName) {
        try {
            // Skip service messages
            if (message.type !== 'message' || !message.text) {
                return false;
            }

            // Extract text content
            let messageText = '';
            if (typeof message.text === 'string') {
                messageText = message.text;
            } else if (Array.isArray(message.text)) {
                messageText = message.text
                    .map(part => typeof part === 'string' ? part : part.text || '')
                    .join('');
            }

            if (!messageText.trim()) {
                return false;
            }

            // Create memory IDs
            const messageId = this.generateUUID(`telegram_${message.id}_${chatId}`);
            const roomId = this.generateUUID(`telegram_chat_${chatId}`);
            const entityId = this.generateUUID(`telegram_user_${message.from_id || 'unknown'}`);

            // Parse date
            const createdAt = new Date(message.date).getTime();

            // Create memory object
            const memory = {
                id: messageId,
                agentId: AGENT_ID,
                entityId: entityId,
                roomId: roomId,
                content: {
                    text: messageText,
                    source: 'telegram_import',
                    channelType: 'DM',
                    metadata: {
                        originalId: message.id,
                        chatName: chatName,
                        importDate: new Date().toISOString(),
                        author: message.from || 'Unknown'
                    }
                },
                createdAt: createdAt
            };

            // Insert into database
            const insertQuery = `
        INSERT INTO memories (
          id, "agentId", "entityId", "roomId", content, "createdAt", type, "isEmbedding"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO NOTHING
      `;

            const result = await this.pool.query(insertQuery, [
                memory.id,
                memory.agentId,
                memory.entityId,
                memory.roomId,
                JSON.stringify(memory.content),
                new Date(memory.createdAt),
                'messages',
                false
            ]);

            if (result.rowCount > 0) {
                this.importedCount++;
                return true;
            } else {
                this.skippedCount++;
                return false;
            }

        } catch (error) {
            console.error(`Error importing message ${message.id}:`, error);
            return false;
        }
    }

    async createEmbeddings() {
        console.log('\n🧠 Creating embeddings for imported messages...');

        try {
            // This would typically be done through ElizaOS runtime
            // For now, we'll just log that embeddings should be created
            console.log('ℹ️  Embeddings will be created automatically when the agent processes the messages');
            console.log('💡 Restart your agent to ensure all imported memories are properly indexed');
        } catch (error) {
            console.error('Error creating embeddings:', error);
        }
    }

    async importTelegramExport(exportPath) {
        try {
            await this.initializeAgent();

            const exportData = await this.parseExportedChat(exportPath);
            const chatName = exportData.name || 'Unknown Chat';
            const chatId = exportData.id || 'unknown';

            console.log(`\n📥 Importing messages from chat: "${chatName}"`);

            // Sort messages by date (oldest first)
            const sortedMessages = exportData.messages.sort((a, b) =>
                new Date(a.date) - new Date(b.date)
            );

            console.log('⏳ Processing messages...');

            for (let i = 0; i < sortedMessages.length; i++) {
                const message = sortedMessages[i];

                if (i % 100 === 0) {
                    console.log(`   Processed ${i}/${sortedMessages.length} messages...`);
                }

                await this.importMessage(message, chatId, chatName);
            }

            console.log(`\n✅ Import completed!`);
            console.log(`📊 Statistics:`);
            console.log(`   - Imported: ${this.importedCount} messages`);
            console.log(`   - Skipped: ${this.skippedCount} messages`);
            console.log(`   - Total processed: ${sortedMessages.length} messages`);

            await this.createEmbeddings();

        } catch (error) {
            console.error('Import failed:', error);
            process.exit(1);
        } finally {
            await this.pool.end();
        }
    }

    async listImportedChats() {
        try {
            await this.initializeAgent();

            const query = `
        SELECT 
          content->>'metadata'->>'chatName' as chat_name,
          COUNT(*) as message_count,
          MIN("createdAt") as first_message,
          MAX("createdAt") as last_message
        FROM memories 
        WHERE "agentId" = $1 
          AND content->>'source' = 'telegram_import'
        GROUP BY content->>'metadata'->>'chatName'
        ORDER BY message_count DESC
      `;

            const result = await this.pool.query(query, [AGENT_ID]);

            if (result.rows.length === 0) {
                console.log('📭 No imported Telegram chats found');
                return;
            }

            console.log('\n📋 Imported Telegram chats:');
            result.rows.forEach((row, index) => {
                console.log(`\n${index + 1}. ${row.chat_name || 'Unknown Chat'}`);
                console.log(`   Messages: ${row.message_count}`);
                console.log(`   Period: ${new Date(row.first_message).toLocaleDateString()} - ${new Date(row.last_message).toLocaleDateString()}`);
            });

        } catch (error) {
            console.error('Error listing chats:', error);
        } finally {
            await this.pool.end();
        }
    }
}

// CLI interface
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    const importer = new TelegramImporter();

    switch (command) {
        case 'import':
            const exportPath = args[1];
            if (!exportPath) {
                console.log('Usage: node telegram-import.js import <path-to-export.json>');
                console.log('Example: node telegram-import.js import ./ChatExport_2025-01-02/result.json');
                process.exit(1);
            }
            await importer.importTelegramExport(exportPath);
            break;

        case 'list':
            await importer.listImportedChats();
            break;

        case 'help':
        default:
            console.log('🤖 Telegram Import Tool for ElizaOS\n');
            console.log('Usage:');
            console.log('  node telegram-import.js import <export-file>  - Import Telegram export JSON');
            console.log('  node telegram-import.js list                 - List imported chats');
            console.log('  node telegram-import.js help                 - Show this help\n');
            console.log('Examples:');
            console.log('  node telegram-import.js import ./ChatExport_2025-01-02/result.json');
            console.log('  node telegram-import.js list\n');
            console.log('First export your Telegram data:');
            console.log('  Telegram Desktop → Settings → Advanced → Export Telegram data');
            break;
    }
}

// Handle uncaught errors
process.on('unhandledRejection', (error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
});

if (import.meta.url === `file://${process.argv[1]}`) {
    main();
} 