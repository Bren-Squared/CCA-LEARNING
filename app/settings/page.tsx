import { getAppDb } from "@/lib/db";
import { getSettingsStatus } from "@/lib/settings";
import SettingsForm from "./SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const status = getSettingsStatus(getAppDb());
  const isFirstRun = !status.apiKeyConfigured;
  return (
    <main className="flex flex-1 flex-col items-center gap-8 px-6 py-12">
      <div className="flex w-full max-w-xl flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {isFirstRun
            ? "Welcome — paste your Anthropic API key to finish setup. The key is encrypted on disk and never sent back to the browser."
            : "Rotate your key or switch the default model. Current key is redacted below."}
        </p>
      </div>
      <SettingsForm initial={status} />
      <div className="flex w-full max-w-xl flex-col gap-1 text-xs text-zinc-500">
        <p>
          Track Claude API spend and the NFR4.2 soft-warning on the{" "}
          <a className="underline" href="/spend">
            spend dashboard
          </a>
          .
        </p>
        <p>
          Keybinds are documented on the{" "}
          <a className="underline" href="/shortcuts">
            shortcuts page
          </a>
          .
        </p>
      </div>
    </main>
  );
}
