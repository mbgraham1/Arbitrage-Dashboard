import { Router, type IRouter } from "express";
import healthRouter from "./health";
import arbRouter from "./arb";

const router: IRouter = Router();

router.use(healthRouter);
router.use(arbRouter);

export default router;
