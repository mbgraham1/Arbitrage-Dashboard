import { Router, type IRouter } from "express";
import healthRouter from "./health";
import arbRouter from "./arb";
import twoExchangeTestRouter from "./two-exchange-test";

const router: IRouter = Router();

router.use(healthRouter);
router.use(arbRouter);
router.use(twoExchangeTestRouter);

export default router;
