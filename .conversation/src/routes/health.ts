import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  // The extracted addon does not include the original workspace's api-zod
  // package. Keep this health response self-contained so the server can build
  // and run from the addon bundle alone.
  res.json({ status: "ok" });
});

export default router;
