import { Router, type IRouter } from "express";
import healthRouter from "./health";
import arbRouter from "./arb";
import twoExchangeTestRouter from "./two-exchange-test";
import twoExchangeScannerRouter from "./two-exchange-scanner";
import cbMakerHedgeRouter from "./cb-maker-hedge";

const router: IRouter = Router();

router.use(healthRouter);
router.use(arbRouter);
router.use(twoExchangeTestRouter);
router.use(twoExchangeScannerRouter);
router.use(cbMakerHedgeRouter);

export default router;
