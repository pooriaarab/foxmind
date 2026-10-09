// The foxmind command. Today it has one subcommand: doctor.
import { doctor, format, type DoctorOptions } from "./doctor.js";

export const USAGE = `Usage: foxmind doctor [--json] [--ollama URL] [--llama-server URL] [--lm-studio URL] [--timeout MS]

Checks which local model servers run on this machine and lists their models.
Exit code 0 when at least one server works, 1 when none does, 2 for bad input.
`;

export interface Output {
  out(text: string): void;
  err(text: string): void;
}

const URL_FLAGS: Record<string, keyof DoctorOptions> = { "--ollama": "ollama", "--llama-server": "llamaServer", "--lm-studio": "lmStudio" };

export async function main(argv: string[], output: Output): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    output.out(USAGE);
    return 0;
  }
  const bad = (why: string) => {
    output.err(`${why}\n\n${USAGE}`);
    return 2;
  };
  if (command !== "doctor") return bad(command ? `Unknown command "${command}".` : "Give a command.");
  const options: DoctorOptions = {};
  let asJson = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    const value = rest[i + 1];
    if (flag === "--json") asJson = true;
    else if (flag in URL_FLAGS) {
      if (!value || !/^https?:\/\//.test(value)) return bad(`${flag} needs an http:// or https:// URL.`);
      (options as Record<string, string>)[URL_FLAGS[flag]!] = value;
      i++;
    } else if (flag === "--timeout") {
      if (!value || !/^\d+$/.test(value)) return bad("--timeout needs a number of milliseconds.");
      options.timeoutMs = Number(value);
      i++;
    } else return bad(`Unknown flag "${flag}".`);
  }
  const report = await doctor(options);
  output.out(asJson ? `${JSON.stringify(report, null, 2)}\n` : format(report));
  return report.checks.some((check) => check.ok) ? 0 : 1;
}
