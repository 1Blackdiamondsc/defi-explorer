'use strict';
const util = require('util');
const {Transform} = require('stream');

const router = require('express').Router();
const JSONStream = require('JSONStream');
const _ = require('underscore');
const mongoose = require('mongoose');

const Wallet = mongoose.model('Wallet');
const WalletAddress = mongoose.model('WalletAddress');
const Transaction = mongoose.model('Transaction');
const Coin = mongoose.model('Coin');

router.post('/', function(req, res) {
  Wallet.create({name: req.body.name}, function(err, result) {
    if(err) {
      res.status(500).send(err);
    }
    res.send(result);
  });
});

router.get('/:walletId', function(req, res) {
  Wallet.findOne({_id: req.params.walletId}, function(err, wallet) {
    if(err) {
      return res.status(500).send(err);
    }
    if(!wallet) {
      return res.status(404).send(new Error('Wallet not found'));
    }
    res.send(wallet);
  });
});

router.get('/:walletId/addresses', function(req, res) {
  Wallet.findOne({_id: req.params.walletId}, function(err, wallet) {
    if(err) {
      return res.status(500).send(err);
    }
    if(!wallet) {
      return res.status(404).send(new Error('Wallet not found'));
    }
    var addressStream = WalletAddress.find({wallet: wallet._id}, {address: true, _id: false}).cursor();
    addressStream.pipe(JSONStream.stringify()).pipe(res);
  });
});

router.post('/:walletId', async (req, res) => {
  let wallet = await Wallet.findOne({ _id: req.params.walletId }).exec();
  if (!wallet) {
    return res.status(404).send(new Error('Wallet not found'));
  }
  let addresses = [];
  try {
    req.body.toString().split('\n').forEach((line) => {
      if (line.length > 2) {
        line = JSON.parse(line);
        let address = line.address;
        if (address) {
          addresses.push(address);
        }
      }
    });
  } catch (err) {
    return res.status(500).send(err);
  }

  let partition = (array, n) => {
    return array.length ? [array.splice(0, n)].concat(partition(array, n)) : [];
  };

  let walletUpdateBatches = addresses.map((address) => {
    return {
      updateOne: {
        filter: { wallet: wallet._id, address: address },
        update: { wallet: wallet._id, address: address },
        upsert: true
      }
    };
  });
  walletUpdateBatches = partition(walletUpdateBatches, 500);
  let coinUpdateBatches = addresses.map((address) => {
    return {
      updateMany: {
        filter: { address: address },
        update: {
          $addToSet: { wallets: wallet._id }
        }
      }
    };
  });
  coinUpdateBatches = partition(coinUpdateBatches, 500);

  try {
    await Promise.all(walletUpdateBatches.map((walletUpdateBatch) => {
      return WalletAddress.bulkWrite(walletUpdateBatch, { ordered: false });
    }));

    await Promise.all(coinUpdateBatches.map((coinUpdateBatch) => {
      return Coin.collection.bulkWrite(coinUpdateBatch, { ordered: false });
    }));

    let coinCursor = Coin.find({ wallets: wallet._id }, { spentTxid: 1, mintTxid: 1}).cursor();

    coinCursor.on('data', function(data){
      coinCursor.pause();
      Transaction.update({txid: {$in: [data.spentTxid, data.mintTxid]}}, {
        $addToSet: { wallets: wallet._id }
      }, function(err){
        coinCursor.resume();
      });
    });

    coinCursor.on('end', function(){
      res.send({ success: true });
    });
  } catch (err){
    return res.status(500).send(err);
  }
});

function ListTransactionsStream(walletId) {
  this.walletId = walletId;
  Transform.call(this, {objectMode: true});
}

util.inherits(ListTransactionsStream, Transform);

ListTransactionsStream.prototype._transform = function(transaction, enc, done) {
  var self = this;
  var wallet = this.walletId.toString();
  var fee = Math.round(transaction.fee * 1e8);
  var sending = _.some(transaction.inputs, function(input) {
    var contains = false;
    _.each(input.wallets, function(inputWallet) {
      if(inputWallet.equals(wallet)) {
        contains = true;
      }
    });
    return contains;
  });

  if(sending) {
    var recipients = 0;
    _.each(transaction.outputs, function(output) {
      var contains = false;
      _.each(output.wallets, function(outputWallet) {
        if(outputWallet.equals(wallet)) {
          contains = true;
        }
      });
      if(!contains) {
        recipients++;
        self.push(JSON.stringify({
          txid: transaction.txid,
          category: 'send',
          satoshis: -Math.round(output.amount * 1e8),
          height: transaction.blockHeight,
          address: output.address,
          outputIndex: output.vout,
          blockTime: transaction.blockTimeNormalized
        }) + '\n');
      }
    });
    if (recipients > 1){
      console.log('probably missing a change address');
      console.log(transaction.txid);
    }
    if(fee > 0) {
      self.push(JSON.stringify({
        txid: transaction.txid,
        category: 'fee',
        satoshis: -fee,
        height: transaction.blockHeight,
        blockTime: transaction.blockTimeNormalized
      }) + '\n');
    }
    return done();
  }

  _.each(transaction.outputs, function(output) {
    var contains = false;
    _.each(output.wallets, function(outputWallet) {
      if(outputWallet.equals(wallet)) {
        contains = true;
      }
    });
    if(contains) {
      self.push(JSON.stringify({
        txid: transaction.txid,
        category: 'receive',
        satoshis: Math.round(output.amount * 1e8),
        height: transaction.blockHeight,
        address: output.address,
        outputIndex: output.vout,
        blockTime: transaction.blockTimeNormalized
      }) + '\n');
    }
  });

  done();
};

router.get('/:walletId/transactions', async (req, res) => {
  let wallet = await Wallet.findOne({ _id: req.params.walletId }).exec();
  if (!wallet) {
    return res.status(404).send(new Error('Wallet not found'));
  }
  var query = {
    wallets: wallet._id
  };
  if (req.query.startBlock) {
    query.blockHeight = { $gte: req.query.startBlock };
  }
  if (req.query.endBlock) {
    query.blockHeight = query.blockHeight || {};
    query.blockHeight.$lte = req.query.endBlock;
  }
  if (req.query.startDate) {
    query.blockTimeNormalized = { $gte: new Date(req.query.startDate) };
  }
  if (req.query.endDate) {
    query.blockTimeNormalized = query.blockTimeNormalized || {};
    query.blockTimeNormalized.$lt = new Date(req.query.endDate);
  }
  var transactionStream = Transaction.find(query).cursor();
  var listTransactionsStream = new ListTransactionsStream(wallet._id);
  transactionStream.pipe(listTransactionsStream).pipe(res);
});

router.get('/:walletId/balance', async (req, res) => {
  let wallet = await Wallet.findOne({ _id: req.params.walletId }).exec();
  if (!wallet) {
    return res.status(404).send(new Error('Wallet not found'));
  }
  var unspent = Coin.aggregate([
    { $match: { wallets: wallet._id, spentTxid: { $exists: false } } },
    {
      $group: {
        _id: null,
        balance: { $sum: '$value' }
      }
    }
  ]);
  try {
    let result = await unspent.exec();
    res.send(result[0]);
  } catch (err){
    return res.status(500).send(err);
  }
});

router.get('/:walletId/utxos', async (req, res) => {
  let wallet = await Wallet.findOne({ _id: req.params.walletId }).exec();
  if (!wallet) {
    return res.status(404).send(new Error('Wallet not found'));
  }
  var utxos = Transaction.collection.aggregate([
    { $match: { 'outputs.wallets': wallet._id } },
    { $unwind: '$outputs' },
    { $match: { 'outputs.wallets': wallet._id, 'outputs.spentTxid': { $exists: false } } },
    {
      $project: {
        'outputs.txid': '$txid',
        'outputs.vout': 1,
        'outputs.address': 1,
        'outputs.script': 1,
        'outputs.amount': 1,
      }
    },
    {
      $replaceRoot: { newRoot: '$outputs' }
    }
  ]);
  utxos.pipe(JSONStream.stringify()).pipe(res);
});

module.exports = {
  router: router,
  path: '/wallet'
};