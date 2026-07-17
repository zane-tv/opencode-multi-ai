/**
 * OpenCode session sidebar: ACTIVE multi-ai account + quota.
 *
 * Target-exclusive TUI module — default export `{ id, tui }` only (no server).
 * Register in ~/.config/opencode/tui.json:
 *   "plugin": ["/absolute/path/to/opencode-multi-ai/lib/plugin/tui.tsx"]
 *
 * @jsxImportSource @opentui/solid
 */

import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui";
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";

import { loadAccounts } from "../core/storage.js";
import {
  buildActiveQuotaRows,
  meterTone,
  type ActiveQuotaRow,
} from "../sidebar/active-quota.js";

const PLUGIN_ID = "opencode-multi-ai.sidebar";
const SIDEBAR_ORDER = 900;
const REFRESH_MS = 5_000;

type PanelState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "ready"; rows: ActiveQuotaRow[]; sessionProviderID?: string }
  | { status: "error"; message: string };

function sessionProviderID(
  api: TuiPluginApi,
  sessionId: string,
): string | undefined {
  try {
    const session = api.state.session.get(sessionId);
    const fromSession = session?.model?.providerID;
    if (typeof fromSession === "string" && fromSession) return fromSession;

    const messages = api.state.session.messages(sessionId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (
        msg &&
        typeof msg === "object" &&
        "role" in msg &&
        msg.role === "assistant" &&
        "providerID" in msg &&
        typeof msg.providerID === "string" &&
        msg.providerID
      ) {
        return msg.providerID;
      }
    }
  } catch {
    /* best-effort */
  }
  return undefined;
}

async function loadPanel(
  api: TuiPluginApi,
  sessionId: string,
): Promise<PanelState> {
  try {
    const storage = await loadAccounts();
    const providerID = sessionProviderID(api, sessionId);
    const rows = buildActiveQuotaRows(storage, Date.now(), {
      sessionProviderID: providerID,
    });
    if (rows.length === 0) return { status: "empty" };
    return { status: "ready", rows, sessionProviderID: providerID };
  } catch (err) {
    return {
      status: "error",
      message: (err as Error).message.slice(0, 120),
    };
  }
}

function toneColor(
  api: TuiPluginApi,
  tone: ReturnType<typeof meterTone>,
): unknown {
  const t = api.theme.current;
  switch (tone) {
    case "ok":
      return t.success;
    case "warn":
      return t.warning;
    case "bad":
      return t.error;
    default:
      return t.textMuted;
  }
}

function ActiveRow(props: { api: TuiPluginApi; row: ActiveQuotaRow }) {
  const pct =
    props.row.remainingPercent === undefined
      ? "—"
      : `${Math.round(props.row.remainingPercent)}%`;
  const plan = props.row.planLabel ? ` · ${props.row.planLabel}` : "";
  const mark = props.row.sessionActive ? "●" : "★";
  const tag = props.row.sessionActive ? " · ACTIVE" : "";
  const titleFg = () =>
    props.row.sessionActive
      ? props.api.theme.current.accent
      : props.api.theme.current.success;
  const meterFg = () =>
    toneColor(props.api, meterTone(props.row.remainingPercent));

  return (
    <box flexDirection="column" marginBottom={0}>
      <text fg={titleFg() as never}>
        {`${mark} ${props.row.providerLabel}  ${props.row.displayName}${plan}${tag}`}
      </text>
      <text fg={meterFg() as never}>{`  │${props.row.meter}│ ${pct}`}</text>
      <Show when={props.row.detail}>
        <text fg={props.api.theme.current.textMuted as never}>
          {`  ${props.row.detail}`}
        </text>
      </Show>
    </box>
  );
}

function ActiveAccountsSidebar(props: {
  api: TuiPluginApi;
  sessionId: string;
}) {
  const [panel, setPanel] = createSignal<PanelState>({ status: "loading" });

  const reload = () => {
    void loadPanel(props.api, props.sessionId).then(setPanel);
  };

  createEffect(() => {
    void props.sessionId;
    reload();
  });

  const interval = setInterval(reload, REFRESH_MS);
  const unsubs = [
    props.api.event.on("session.updated", reload),
    props.api.event.on("session.status", reload),
    props.api.event.on("message.updated", reload),
    props.api.event.on("message.part.updated", reload),
    props.api.event.on("tui.session.select", reload),
  ];
  onCleanup(() => {
    clearInterval(interval);
    for (const u of unsubs) u();
  });

  return (
    <box flexDirection="column" gap={0}>
      <text fg={props.api.theme.current.text as never}>
        <b>Accounts</b>
      </text>
      <Show when={panel().status === "loading"}>
        <text fg={props.api.theme.current.textMuted as never}>Loading…</text>
      </Show>
      <Show when={panel().status === "error"}>
        <text fg={props.api.theme.current.error as never}>
          {(panel() as { status: "error"; message: string }).message}
        </text>
      </Show>
      <Show when={panel().status === "empty"}>
        <text fg={props.api.theme.current.textMuted as never}>
          No multi-ai accounts
        </text>
        <text fg={props.api.theme.current.textMuted as never}>
          Run: op-ai tui → a
        </text>
      </Show>
      <Show when={panel().status === "ready"}>
        <For
          each={(panel() as { rows: ActiveQuotaRow[] }).rows}
        >
          {(row) => <ActiveRow api={props.api} row={row} />}
        </For>
      </Show>
    </box>
  );
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        return (
          <ActiveAccountsSidebar api={api} sessionId={props.session_id} />
        );
      },
    },
  });
};

const pluginModule: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
};

export default pluginModule;
