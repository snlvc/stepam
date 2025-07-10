module.exports = {
    apps: [
        {
            name: 'stepam',
            script: 'bun',
            args: 'start',
            cwd: './packages/cli',
            env: {
                NODE_ENV: 'production',
                POSTGRES_URL: 'postgres://postgres:postgres@localhost:5432/eliza',
            },
            autorestart: true,
            max_restarts: 10,
            restart_delay: 5000,
        }
    ]
}; 