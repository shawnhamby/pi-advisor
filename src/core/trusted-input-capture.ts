import type { ExtensionContext, InputEvent } from '@earendil-works/pi-coding-agent';

type TrustedInputCapture = {
  accept?: (event: InputEvent, ctx: ExtensionContext) => boolean | Promise<boolean>;
  event: InputEvent;
  ctx: ExtensionContext;
  capture(): void;
};

export async function captureTrustedInput(input: TrustedInputCapture): Promise<boolean> {
  try {
    if (input.accept && !(await input.accept(input.event, input.ctx))) return false;
  } catch {
    return false;
  }
  input.capture();
  return true;
}
