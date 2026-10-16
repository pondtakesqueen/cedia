import { describe, expect, test } from "vitest";
import { gateReason } from "../src/gate.ts";

describe("gateReason pauses irreversible commands", () => {
  test.each([
    "git push --force origin main",
    "git push -f",
    "git push origin +main",
    "git push --force-with-lease=main origin main",
    "git reset --hard HEAD~3",
    "git clean -fdx",
    "git checkout -- .",
    "rm -rf /",
    "rm -rf ~",
    "rm -fr $HOME",
    "rm -rf ~/projects",
    "cd x && rm -r -f .",
    "rm -rf *",
    "npm publish",
    "gh release create v1",
    "docker push me/app",
    "vercel deploy --prod",
    "terraform apply -auto-approve",
    "kubectl delete ns prod",
    "gh pr merge 12",
    "gh pr create --fill",
    "curl -X POST https://hooks.slack.com/services/x",
    "bash -c 'git push -f'",
    "bash -c 'rm -rf ~'",
    "echo 'git push --force'",
  ])("%s", (cmd) => {
    expect(gateReason(cmd)).toBeDefined();
  });
});

describe("gateReason lets ordinary work run", () => {
  test.each([
    "git push origin feature",
    "git push",
    "git status",
    "git reset --soft HEAD~1",
    "git checkout -- src/a.ts",
    "rm -rf node_modules",
    "rm -rf ./dist",
    "rm -rf ~/projects/app/build",
    "rm -f /tmp/x.log",
    "npm test",
    "gh pr view 12",
    "gh pr list",
  ])("%s", (cmd) => {
    expect(gateReason(cmd)).toBeUndefined();
  });
});
