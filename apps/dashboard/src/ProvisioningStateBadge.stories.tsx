import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProvisioningStateBadge } from "./ProvisioningStateBadge";

const meta = {
  title: "Provisioning/State badge",
  component: ProvisioningStateBadge,
  args: { state: "configuring" },
} satisfies Meta<typeof ProvisioningStateBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Configuring: Story = {};
export const Active: Story = { args: { state: "active" } };
export const RepairRequired: Story = { args: { state: "repair_required" } };
