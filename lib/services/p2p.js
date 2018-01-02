const util = require('util');
const cluster = require('cluster');
const {EventEmitter} = require('events');
const {tx, block } = require('bcoin');
const { Networks } = require('bitcore-lib');
const { Pool, Messages } = require('bitcore-p2p');

var mongoose = require('mongoose');
var async = require('async');
var ProgressBar = require('progress');

var config = require('../config');
var Block = mongoose.model('Block');
var Transaction = mongoose.model('Transaction');

var P2pService = function() {
  this.headersQueue = [];
  this.blockCache = {};
  this.syncing = false;
  this.blockRates = [];

};

util.inherits(P2pService, EventEmitter);

P2pService.prototype.start = function(ready) {
  var self = this;
  if(config.chainSource !== 'p2p') {
    return setImmediate(ready);
  }
  if(cluster.isWorker) {
    process.on('message', function(payload) {
      if(payload.task === 'syncTransactionAndOutputs') {
        Transaction.syncTransactionAndOutputs(payload.argument, function(err) {
          process.send({id: payload.id, error: err});
        });
      }
      if(payload.task === 'syncTransactionInputs') {
        Transaction.syncTransactionInputs(payload.argument, function(err) {
          process.send({id: payload.id, error: err});
        });
      }
    });
    return setImmediate(ready);
  }

  this.connect(function(){
    self.on('block', self.blockHandler.bind(self));
    self.on('transaction', self.transactionHandler.bind(self));
    ready();
  });
};

P2pService.prototype.connect = function(ready){
  ready = ready || function(){};
  this.messages = new Messages({
    network: Networks.get('main'),
    Transaction: tx,
    Block: block
  });
  this.pool = new Pool({
    addrs: [
      {
        ip: {
          v4: '127.0.0.1'
        },
        port: 8333
      }
    ],
    dnsSeed: false,
    listenAddr: false,
    network: 'main',
    messages: this.messages
  });

  this.pool.on('peerready', (peer) => {
    console.log(`Connected to peer ${peer.host}`);
    this.sync();
    this.emit('ready');
  });

  this.pool.on('peertx', (peer, message) => {
    this.emit('transaction', message.transaction);
  });

  this.pool.on('peerblock', (peer, message) => {
    this.emit(message.block.rhash(), message.block);
    this.emit('block', message.block);
  });

  this.pool.on('peerheaders', (peer, message) => {
    this.emit('headers', message.headers);
  });

  this.pool.on('peerinv', (peer, message) => {
    peer.sendMessage(this.messages.GetData(message.inventory));
  });

  this.once('ready', ready);

  this.pool.connect();
};

P2pService.prototype.stop = function() {

};

P2pService.prototype.sync = function(done) {
  var self = this;
  done = done || function() {};
  if (this.syncing){
    return done();
  }
  this.syncing = true;
  Block.getLocalTip(function(err, bestBlock) {
    if(bestBlock.height === self.getPoolHeight()) {
      self.syncing = false;
      return done();
    }
    var counter = 0;
    var bar = new ProgressBar('syncing [:bar] :percent :blockRate s/block :blocksEta hrs :blockTime :current', {
      curr: bestBlock.height,
      complete: '=',
      incomplete: ' ',
      width: 30,
      total: self.getPoolHeight()
    });

    async.during(
      function(cb) {
        self.getHeaders(function(err, headers) {
          self.headersQueue = headers;
          cb(err, headers.length);
        });
      },
      function(cb) {
        async.eachSeries(self.headersQueue, function(header, cb) {
          var start = Date.now();
          self.getBlock(header.hash, function(err, block) {
            Block.addBlock(block, function(err) {
              delete self.blockCache[header.hash];
              var end = Date.now();
              counter++;
              self.blockRates.push(((end - start) / 1000));
              if(self.blockRates.length > 144) {
                self.blockRates.shift();
              }
              var avgBlockRate = self.blockRates.reduce(function(p, c, i, a) {return p + (c / a.length);}, 0);
              bar.tick({
                blockTime: new Date(block.ts * 1000).toISOString(),
                blockRate: avgBlockRate.toFixed(2),
                blocksEta: ((((self.getPoolHeight() - bestBlock.height) - counter) * avgBlockRate) / 3600).toFixed(2)
              });
              cb(err);
            });
          });
        }, function(err) {
          cb(err);
        });
      },
      function(err) {
        if(err) {
          console.error(err);
          self.sync();
        } else {
          console.log('Sync completed!!');
          self.syncing = false;
        }
      }
    );
  });
};

P2pService.prototype.getPoolHeight = function() {
  return Object.values(this.pool._connectedPeers).reduce((best, peer) => { return Math.max(best, peer.bestHeight); }, 0);
};

P2pService.prototype._getHeaders = function(candidateHashes, callback) {
  this.pool.sendMessage(this.messages.GetHeaders({starts: candidateHashes}));
  this.once('headers', function(headers){
    callback(null, headers);
  });
};

P2pService.prototype.getHeaders = function(callback) {
  Block.getLocatorHashes((err, locatorHashes) => {
    if(err) {
      return callback(err);
    }
    this._getHeaders(locatorHashes, (err, headers) => {
      if(err) {
        return callback(err);
      }
      callback(null, headers);
    });
  });
};

P2pService.prototype.getBlock = function(hash, callback) {
  if (this.blockCache[hash]){
    return callback(null, this.blockCache[hash]);
  }
  this.pool.sendMessage(this.messages.GetData.forBlock(hash));
  this.once(hash, (block) => {
    callback(null, block);
  });
};

P2pService.prototype.blockHandler = function(block) {
  if(this.syncing) {
    return;
  }
  Block.addBlock(block, function(err) {
    if(err){
      console.error(err);
    } else {
      console.log('Added block:\t' + block.rhash());
    }
  });
};

P2pService.prototype.transactionHandler = function(transaction) {
  Transaction.addTransaction({
    transaction: transaction,
    network: config.network,
    mainChain: true,
    mempool: true,
    outputs: transaction.outputs
  }, function(err, transaction) {

  });
};


module.exports = new P2pService();
