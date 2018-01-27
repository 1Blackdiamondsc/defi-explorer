const bitcore = require('bitcore-lib');
const Config = function(){
  let config = {
    chainSource: 'p2p',
    network: 'testnet',
    numWorkers: require('os').cpus().length,
    maxPoolSize: 10,
    port: 3000,
    dbHost: '127.0.0.1',
    dbName: 'bitcore',
    trustedPeers: [
      {host: '127.0.0.1', port: 18333}
    ]
  };

  let options;
  try {
    options = require('../config.json');
  } catch(e) {
    options = {};
  }

  Object.assign(config, options);
  if (!bitcore.Networks.get(config.network)){
    throw new Error('Unknown network specified in config');
  }
  return config;
};

module.exports = new Config();