export default {
    apps: [{
        name: 'elizaos',
        script: 'packages/cli/dist/index.js',
        interpreter: 'bun',
        env: {
            NODE_ENV: 'production',
            POSTGRES_URL: 'postgres://postgres:postgres@localhost:5432/eliza',
            OPENAI_API_KEY: process.env.OPENAI_API_KEY,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
            SERVER_PORT: process.env.SERVER_PORT || '3000'
        },
        args: 'start --character packages/cli/src/characters/stepan.ts',
        cwd: '/stepam',
        watch: false,
        max_memory_restart: '1G',
        exp_backoff_restart_delay: 100,
        merge_logs: true,
        log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }]
} 