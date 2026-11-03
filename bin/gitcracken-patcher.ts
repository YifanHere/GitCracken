import chalk from "chalk";
import * as program from "commander";
import * as emoji from "node-emoji";

import {Logo, Patcher, PatcherV12} from "../";

const enum Actions {
  backup = 1,
  unpack = 2,
  patch = 3,
  pack = 4,
  remove = 5,
  revert = 6,
}

const V12_FEATURES = ["v12", "advanced"];

function parseActions(list: string[]): Actions[] {
  const actions: Actions[] = [];
  for (const item of list) {
    switch (item.toLowerCase()) {
      case "backup":
        actions.push(Actions.backup);
        break;
      case "unpack":
        actions.push(Actions.unpack);
        break;
      case "patch":
        actions.push(Actions.patch);
        break;
      case "pack":
        actions.push(Actions.pack);
        break;
      case "remove":
        actions.push(Actions.remove);
        break;
      case "revert":
        actions.push(Actions.revert);
        break;
      default:
        console.error(
          `${chalk.red("==>")} Unknown action ${chalk.bold(
            item,
          )}, expected: backup, unpack, patch, pack, remove, revert`,
        );
        process.exit(1);
    }
  }
  return actions;
}

function printPatchResult(result: ReturnType<Patcher["patch"]>): void {
  if (result.mode === "v12") {
    if (result.alreadyPatched) {
      console.log(
        `${chalk.green("==>")} ${emoji.get(
          "white_check_mark",
        )} Already patched, nothing to do.`,
      );
      return;
    }
    console.log(
      `${chalk.green("==>")} ${emoji.get("hammer")} Patched ${
        result.patched
      } license selector(s) in place.`,
    );
    if (result.mirrored) {
      console.log(
        `${chalk.green("==>")} ${emoji.get(
          "sparkles",
        )} Mirrored the patch into the extracted app directory (${
          result.mirrored
        } file(s)).`,
      );
    }
    return;
  }

  console.log(
    `${chalk.green("==>")} ${emoji.get("hammer")} Patched legacy features.`,
  );
}

async function executeActions(strActions?: string[]): Promise<void> {
  Logo.print();

  const patcher = new Patcher({
    asar: program.asar,
    dir: program.dir,
    features: ((program.feature as string[]) || []).slice(),
  });

  const version = patcher.gitKrakenVersion;

  if (!patcher.features.length) {
    patcher.features.push(patcher.suggestFeature());
  }

  console.log(
    `${chalk.green("==>")} ${emoji.get("information_source")} GitKraken ` +
      `${chalk.bold(version || "unknown")} | ` +
      `${chalk.bold(patcher.isV12Mode ? "v12" : "legacy")} mode | ` +
      `features: ${patcher.features
        .map((feature) => chalk.green(feature))
        .join(", ")}`,
  );

  if (program.check) {
    if (!patcher.isV12Mode) {
      console.log(
        `${chalk.yellow("==>")} ${emoji.get(
          "warning",
        )} --check is only available for the v12 mode.`,
      );
      return;
    }
    const scan = new PatcherV12(patcher.asar, patcher.dir).scan();
    const patched = scan.hits.length === 0 && scan.patchedMarkers > 0;
    console.log(
      `${chalk.green("==>")} ${emoji.get(patched ? "white_check_mark" : "x")} ` +
        `selectors to patch: ${chalk.bold(String(scan.hits.length))} | ` +
        `patched markers: ${chalk.bold(String(scan.patchedMarkers))} | ` +
        `state: ${chalk.bold(patched ? "patched" : "not patched")}`,
    );
    for (const hit of scan.hits) {
      console.log(`    @${hit.offset}  ${hit.selector.slice(0, 120)}`);
    }
    return;
  }

  let actions = parseActions(strActions || []);
  if (!actions.length) {
    actions = patcher.isV12Mode
      ? [Actions.backup, Actions.patch]
      : [
          Actions.backup,
          Actions.unpack,
          Actions.patch,
          Actions.pack,
          Actions.remove,
        ];
  }
  if (program.backup === false) {
    actions = actions.filter((action) => action !== Actions.backup);
  }

  for (const action of actions) {
    switch (action) {
      case Actions.backup: {
        const backup = patcher.isV12Mode
          ? patcher.backupAsarOnce()
          : patcher.backupAsar();
        console.log(
          `${chalk.green("==>")} ${emoji.get("package")} Backup ` +
            `${chalk.green(patcher.asar)} → ${chalk.green(backup)}`,
        );
        break;
      }
      case Actions.unpack: {
        console.log(
          `${chalk.green("==>")} ${emoji.get("unlock")} Unpack ${chalk.green(
            patcher.asar,
          )} → ${chalk.green(patcher.dir)}`,
        );
        patcher.unpackAsar();
        break;
      }
      case Actions.patch: {
        console.log(
          `${chalk.green("==>")} ${emoji.get("hammer")} Patch ${chalk.green(
            patcher.isV12Mode ? patcher.asar : patcher.dir,
          )} with ${patcher.features
            .map((feature) => `${chalk.green(feature)}`)
            .join(", ")} features`,
        );
        printPatchResult(patcher.patch());
        break;
      }
      case Actions.pack: {
        console.log(
          `${chalk.green("==>")} ${emoji.get("lock")} Pack ${chalk.green(
            patcher.dir,
          )} → ${chalk.green(patcher.asar)}`,
        );
        await patcher.packDirAsync();
        break;
      }
      case Actions.remove: {
        console.log(
          `${chalk.green("==>")} ${emoji.get("fire")} Remove ${chalk.green(
            patcher.dir,
          )}`,
        );
        patcher.removeDir();
        break;
      }
      case Actions.revert: {
        const backup = patcher.revertAsar();
        console.log(
          `${chalk.green("==>")} ${emoji.get("rewind")} Restored ` +
            `${chalk.green(patcher.asar)} from ${chalk.green(backup)}`,
        );
        break;
      }
    }
  }

  console.log(`${chalk.green("==>")} ${emoji.get("ok_hand")} Done!`);
}

program
  .name("gitcracken-patcher")
  .description(
    "GitKraken patcher (v12+ uses the in-place license selector patch)",
  )
  .option("-a, --asar <file>", "app.asar file")
  .option("-d, --dir <dir>", "app directory")
  .option(
    "-f, --feature <value>",
    `patcher feature (${V12_FEATURES.join(", ")} for GitKraken 10+, ` +
      "or a file name from the patches directory for older versions)",
    (val: string, memo: string[]) => {
      memo.push(val);
      return memo;
    },
    [] as string[],
  )
  .option("-c, --check", "only report the current v12 patch state")
  .option("--no-backup", "do not create an app.asar backup")
  .arguments("[actions...]")
  .action(async (strActions?: string[]) => {
    await executeActions(strActions);
  })
  .parse(process.argv);
