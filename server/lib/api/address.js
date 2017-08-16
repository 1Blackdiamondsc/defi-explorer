const Block   = require('../../models/block.js');
const logger  = require('../logger');
const request = require('request');
const config  = require('../../config');
const db      = require('../db');

console.log(db);

const MAX_BLOCKS = 200;

// Shoe horned in. Not dry, also in blocks. Make db api later
function getBlock(params, options, limit, cb) {
  const defaultOptions = { _id: 0 };

  if (!Number.isInteger(limit)) {
    limit = MAX_BLOCKS;
  }

  Object.assign(defaultOptions, options);

  Block.find(
    params,
    defaultOptions,
    cb)
    .sort({ height: -1 })
    .limit(limit);
}

module.exports = function AddressAPI(router) {
  router.get('/addr/:addr', (req, res) => {
    getBlock(
      {},
      { height: 1 },
      1,
      (err, block) => {
        if (err) {
          res.status(501).send();
          logger.log('err', err);
        }
        if (block[0]) {
          const height = block[0].height;
          request(`http://${config.bcoin_http}:${config.bcoin['http-port']}/tx/address/${req.params.addr}`, (err, localRes, body) => {
            if (err) {
              logger.log('error',
                `${err}`);
            }
            try {
              body = JSON.parse(body);
            } catch (e) {
              logger.log('error',
                `${err}`);
            }

            const totalReceived = body.reduce((sum, tx) => sum + tx.outputs.reduce((sum, output) => {
              if (output.address === req.params.addr) {
                return sum + output.value;
              }
              return sum;
            }, 0), 0) || 0;

            const totalSpent = body.reduce((sum, tx) => sum + tx.inputs.reduce((sum, input) => {
              if (input.coin && input.coin.address === req.params.addr) {
                return sum + input.coin.value;
              }
              return sum;
            }, 0), 0) || 0;



            res.json({
              addrStr: req.params.addr,
              balance: (totalReceived - totalSpent) / 1e8,
              balanceSat: totalReceived - totalSpent,
              totalReceived: totalReceived / 1e8,
              totalReceivedSat: totalReceived,
              totalSent: totalSpent / 1e8,
              totalSentSat: totalSpent,
              unconfirmedBalance: 0,
              unconfirmedBalanceSat: 0,
              unconfirmedTxApperances: 0,
              txApperances: body.length,
            });
          });
        }
      });
  });

  router.get('/addr/:addr/utxo', (req, res) => {
    res.send('1');
  });

  router.get('/addr/:addr/balance', (req, res) => {
    res.send('2');
  });

  router.get('/addr/:addr/totalReceived', (req, res) => {
    res.send('3');
  });

  router.get('/addr/:addr/totalSent', (req, res) => {
    res.send('4');
  });

  router.get('/addr/:addr/unconfirmedBalance', (req, res) => {
    res.send('5');
  });

  router.get('/addrs/:addrs/utxo', (req, res) => {
    res.send('6');
  });

  router.post('/addrs/utxo', (req, res) => {
    res.send('7');
  });

  router.get('/addrs/:addrs/txs', (req, res) => {
    getBlock(
      {
        $or:
        [
          { 'txs.outputs.address': req.params.addr },
          { 'txs.inputs.prevout.hash': req.params.addr },
        ],
      },
      { rawBlock: 0 },
      MAX_BLOCKS,
      (err, block) => {
        if (err) {
          res.status(501).send();
          logger.log('err', err);
        }

        if (block[0]) {
          const b = block[0];
          res.json({
            pagesTotal: 1,
            txs: b.txs.map(tx => ({
              txid: tx.hash,
              version: tx.version,
              locktime: tx.locktime,
              vin: tx.inputs.map(input => ({
                coinbase: input.script,
                sequence: input.sequence,
                n: 0,
                addr: input.address,
              })),
              vout: tx.outputs.map(output => ({
                value: output.value / 1e8,
                n: 0,
                scriptPubKey: {
                  hex: '',
                  asm: '',
                  addresses: [output.address],
                  type: output.type,
                },
                spentTxid: '',
                spentIndex: 0,
                spentHeight: 0,
              })),
            })),
          });
        } else {
          res.send();
        }
      });
  });

  router.post('/addrs/txs', (req, res) => {
    res.send('post stub');
  });
};
