import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import type { Preview } from "@storybook/react-vite";

const preview: Preview = {
  decorators: [
    (Story) => (
      <ChakraProvider value={defaultSystem}>
        <Story />
      </ChakraProvider>
    ),
  ],
};

export default preview;
