import { defineConfig } from "@rspack/cli";
import HtmlRspackPlugin from "html-rspack-plugin";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isDemo = process.env.BUILD_MODE === 'demo';

export default defineConfig({
  context: __dirname,
  experiments: isDemo ? {} : {
    outputModule: true,
  },
  entry: isDemo ? {
    main: "./examples/demo.ts",
  } : {
    index: "./src/index.ts",
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js", ".jsx"],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: [
          {
            loader: "builtin:swc-loader",
            options: {
              jsc: {
                parser: {
                  syntax: "typescript",
                  tsx: true,
                },
              },
            },
          },
        ],
        type: "javascript/auto",
      },
    ],
  },
  plugins: isDemo ? [
    new HtmlRspackPlugin({
      template: "./index.html",
    }),
  ] : [],
  output: isDemo ? {
    path: join(__dirname, "dist"),
    clean: true,
  } : {
    path: join(__dirname, "dist"),
    filename: "[name].js",
    library: {
      type: "module",
    },
    globalObject: "this",
    clean: true,
  },
  devServer: isDemo ? {
    port: 3000,
    hot: true,
    open: true,
    static: {
      directory: __dirname,
    },
  } : undefined,
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  externals: isDemo ? {} : {
    // No external dependencies for now, but can be added if needed
  },
});

