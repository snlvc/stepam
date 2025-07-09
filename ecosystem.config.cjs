module.exports = {
    apps: [
        {
            name: 'stepam',
            cwd: '/root/stepam',
            script: 'bun',
            args: 'start',
            interpreter: 'none',
            restart_delay: 1000,
            max_restarts: 3,
            autorestart: true,
            watch: false,
            env: {
                NODE_ENV: 'production'
            }
        }
    ]
};
