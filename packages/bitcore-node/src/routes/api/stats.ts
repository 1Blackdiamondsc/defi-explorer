import { Request, Response } from 'express';
import { ChainStateProvider } from '../../providers/chain-state';
import HealthCheck from '../../healthCheckCron'
import { HEATHCHECK_CRITICAL_THRESHOLD } from '../../constants/config'
const router = require('express').Router({ mergeParams: true });

router.get('/', async function (req: Request, res: Response) {
  try {
    const { chain, network } = req.params;
    const result = await ChainStateProvider.getStats({ chain, network });
    return res.send(result);
  } catch (err) {
    return res.status(500).send(err);
  }
});

router.get('/total-coin', async function (req: Request, res: Response) {
  try {
    const { chain, network } = req.params;
    const result = await ChainStateProvider.getCoinCalculation({ chain, network });
    return res.send(result);
  } catch (err) {
    return res.status(500).send(err);
  }
});


router.get('/health', async function (req: Request, res: Response) {
  if (HealthCheck.criticalCount < HEATHCHECK_CRITICAL_THRESHOLD) {
    return res.status(200).send("Healthy");
  } else {
    return res.status(500).send('Critical');
  }
});

let cacheThroughTruncatedDate;
let cachedDailyTransactions;
router.get('/daily-transactions', async function (req: Request, res: Response) {
  const { chain, network } = req.params;
  const truncatedUTC = new Date().toISOString().split('T')[0];
  if (truncatedUTC === cacheThroughTruncatedDate) {
    return res.json(cachedDailyTransactions);
  }
  try {
    cachedDailyTransactions = await ChainStateProvider.getDailyTransactions({ chain, network });
    if (!cachedDailyTransactions) {
      return res.send(500);
    }
    cacheThroughTruncatedDate = truncatedUTC;
    return res.json(cachedDailyTransactions);
  } catch (err) {
    return res.status(500).send(err);
  }
});

module.exports = {
  router: router,
  path: '/stats'
};
