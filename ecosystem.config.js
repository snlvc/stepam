module.exports = {
    apps: [
        {
            name: 'stepam',
            cwd: '/root/stepam',
            script: 'bun',
            args: 'start',
            interpreter: 'none', // Important for Bun, so PM2 doesn't use node
            restart_delay: 1000, // 1 second between restarts
            max_restarts: 3, // Will only try to restart 3 times
            autorestart: true,
            watch: false, // Optional: don't restart on file change
            env: {
                NODE_ENV: 'production'
            }
        }
    ]
};