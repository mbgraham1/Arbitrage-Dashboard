import { Router, type IRouter } from "express";
import healthRouter from "./health";
import arbRouter from "./arb";
import twoExchangeTestRouter from "./two-exchange-test";
import twoExchangeScannerRouter from "./two-exchange-scanner";
import cbMakerHedgeRouter from "./cb-maker-hedge";
import discoveryRouter from "./discovery";
import geminiRouter from "./gemini";
import crossVenueRouter from "./cross-venue";
import profitHunterRouter from "./profit-hunter";

const router: IRouter = Router();

router.use(healthRouter);
router.use(arbRouter);
router.use(twoExchangeTestRouter);
router.use(twoExchangeScannerRouter);
router.use(cbMakerHedgeRouter);
router.use(discoveryRouter);
router.use(geminiRouter);
router.use(crossVenueRouter);
router.use(profitHunterRouter);

export default router;
