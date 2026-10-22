import { AssistantPanel, type AssistantPanelProps } from "./AssistantPanel";
import { Overlay } from "./Overlay";

/** Quick, contextual access to the assistant from any workspace. The full workspace is the Assistant page. */
export function AssistantDrawer({ open, onClose, ...p }: Omit<AssistantPanelProps, "variant" | "onClose"> & { open: boolean; onClose: () => void }) {
  return (
    <Overlay open={open} onClose={onClose} variant="drawer" label="Ask HomeRelay">
      <AssistantPanel {...p} variant="drawer" onClose={onClose} />
    </Overlay>
  );
}
