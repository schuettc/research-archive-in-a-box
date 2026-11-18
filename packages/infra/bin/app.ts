import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { App, Stack, Tags } from "aws-cdk-lib";
import { CertificateStack } from "../src/certificate";
import { loadArchiveConfig, stagesOf } from "../src/config";
import { ResearchArchive } from "../src/research-archive";

const ARCHIVE_YAML = fileURLToPath(new URL("../../../archive.yaml", import.meta.url));

export function stackName(stage: string): string {
  return `ResearchArchive-${stage}`;
}

/** The config file: `ARCHIVE_CONFIG` when set, so a test stage needs no edit to archive.yaml. */
export function createApp(configPath: string = process.env.ARCHIVE_CONFIG ?? ARCHIVE_YAML): App {
  const config = loadArchiveConfig(configPath);
  const app = new App();
  for (const stage of stagesOf(config)) {
    const env =
      stage.account || stage.region
        ? { account: stage.account ?? undefined, region: stage.region ?? undefined }
        : undefined;
    // A stage with a domain gets its certificate from a stack in us-east-1, read across regions;
    // a stage with none is built exactly as before, with no crossRegionReferences at all.
    let certificate: CertificateStack["certificate"] | undefined;
    if (stage.domain) {
      if (!stage.region) {
        throw new Error(
          `stage ${stage.name} has a domain, so it needs a region: the certificate is made in ` +
            "us-east-1 and referenced from the stage's region",
        );
      }
      certificate = new CertificateStack(app, `${stackName(stage.name)}-Certificate`, {
        domain: stage.domain,
        account: stage.account ?? undefined,
      }).certificate;
    }
    const stack = new Stack(
      app,
      stackName(stage.name),
      certificate ? { env, crossRegionReferences: true } : { env },
    );
    new ResearchArchive(stack, "Archive", {
      config,
      stage: stage.name,
      configDir: dirname(configPath),
      certificate,
    });
  }
  Tags.of(app).add("Repo", "schuettc/research-archive-in-a-box");
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().synth();
}
