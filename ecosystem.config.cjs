// pm2: pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
module.exports = {
  apps: [{
    name: 'xagent',
    script: 'src/index.js',
    exp_backoff_restart_delay: 5000, // crash berulang -> jeda restart makin panjang, tidak membanjiri laporan
    max_memory_restart: '400M',
    kill_timeout: 5000, // beri waktu simpan data.json sebelum dimatikan
    time: true // timestamp di log
  }]
};
