import { expect, test, vi } from "vitest";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import {
  getPermissionSystemStatus,
  PERMISSION_SYSTEM_STATUS_KEY,
  syncPermissionSystemStatus,
} from "#src/status";

/**
 * Build a minimal faux-UI whose theme records how each style helper was used
 * while still passing text through, so tests can assert the applied styling
 * without depending on concrete ANSI escapes.
 */
function makeFauxUi() {
  const theme = {
    fg: vi.fn((_color: string, text: string) => `fg(${_color},${text})`),
    bold: vi.fn((text: string) => `bold(${text})`),
  };
  const setStatus = vi.fn();
  return { ui: { theme, setStatus }, theme, setStatus };
}

test("Permission-system status is only exposed when yolo mode is enabled", () => {
  expect(getPermissionSystemStatus(DEFAULT_EXTENSION_CONFIG)).toBe(undefined);
  expect(
    getPermissionSystemStatus({ ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }),
  ).toBe("yolo");
});

test("syncPermissionSystemStatus renders yolo as a red, bold status when enabled", () => {
  const { ui, theme, setStatus } = makeFauxUi();

  syncPermissionSystemStatus({ ui } as never, {
    ...DEFAULT_EXTENSION_CONFIG,
    yoloMode: true,
  });

  expect(theme.fg).toHaveBeenCalledExactlyOnceWith(
    "error",
    theme.bold.mock.results[0]?.value,
  );
  expect(theme.bold).toHaveBeenCalledExactlyOnceWith("yolo");
  expect(setStatus).toHaveBeenCalledExactlyOnceWith(
    PERMISSION_SYSTEM_STATUS_KEY,
    theme.fg.mock.results[0]?.value,
  );
});

test("syncPermissionSystemStatus clears the yolo status when disabled", () => {
  const { ui, setStatus } = makeFauxUi();

  syncPermissionSystemStatus({ ui } as never, DEFAULT_EXTENSION_CONFIG);

  expect(setStatus).toHaveBeenCalledExactlyOnceWith(
    PERMISSION_SYSTEM_STATUS_KEY,
    undefined,
  );
});
