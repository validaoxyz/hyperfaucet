import path from 'path';
import webpack from 'webpack';
import wpmerge from 'webpack-merge';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import MinimizerPlugin from "minimizer-webpack-plugin";
import Visualizer from 'webpack-visualizer-plugin2';
import { execFileSync } from 'node:child_process';
import cliArgs from './utils/CliArgs.js';
import pkgJson from './package.json' with { type: 'json' };

var debug = false;
if(cliArgs['dev'])
  debug = true;

function parseEpochSeconds(value, source) {
  if(!/^\d+$/.test(value))
    throw new Error(`${source} must be a non-negative integer`);

  const epochSeconds = Number(value);
  if(!Number.isSafeInteger(epochSeconds))
    throw new Error(`${source} is outside the safe integer range`);
  return epochSeconds;
}

function resolveBuildTime() {
  const configuredEpoch = process.env.SOURCE_DATE_EPOCH?.trim();
  if(configuredEpoch)
    return parseEpochSeconds(configuredEpoch, "SOURCE_DATE_EPOCH") * 1000;

  let gitEpoch;
  try {
    gitEpoch = execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
      cwd: import.meta.dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return 0;
  }
  return parseEpochSeconds(gitEpoch, "git commit time") * 1000;
}

const buildTime = resolveBuildTime();

var webpackModuleConfigs = [
  {
    entry: './src/main',
    output: {
      path: path.join(import.meta.dirname, '/dist'),
      filename: 'powfaucet.js'
    },
    module: {
      rules: [
        {
          test: /\.s?css$/,
          use: [
            MiniCssExtractPlugin.loader,
            'css-loader',
            {
              loader: 'sass-loader',
              options: {
                // don't emit a BOM/@charset in the sass output: it ends up
                // mid-file after bundling and invalidates the first selector
                sassOptions: {
                  charset: false
                }
              }
            }
          ]
        }
      ]
    },
    plugins: [
      new MiniCssExtractPlugin({
        filename: 'powfaucet.css',
        chunkFilename: 'powfaucet.[name].css',

      }),
    ]
  },
  {
    entry: './src/worker/worker-scrypt',
    output: {
      path: path.join(import.meta.dirname, '/dist'),
      filename: 'powfaucet-worker-sc.js',
    },
  },
  {
    entry: './src/worker/worker-cryptonight',
    output: {
      path: path.join(import.meta.dirname, '/dist'),
      filename: 'powfaucet-worker-cn.js',
    },
  },
  {
    entry: './src/worker/worker-argon2',
    output: {
      path: path.join(import.meta.dirname, '/dist'),
      filename: 'powfaucet-worker-a2.js',
    },
  },
  {
    entry: './src/worker/worker-nickminer',
    output: {
      path: path.join(import.meta.dirname, '/dist'),
      filename: 'powfaucet-worker-nm.js',
    },
  },
];

var webpackBaseConfig = {
  mode: debug ? "development" : "production",
  devtool: "source-map",

  resolve: {
    extensions: ['.ts', '.tsx', '.js']
  },
  target: ['web', 'es5'],

  module: {
    rules: [
      // babel-loader to load our jsx and tsx files
      {
        test: /\.(ts|js)x?$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              ["@babel/preset-env", {
                modules: false
              }],
              "@babel/preset-typescript",
              ["@babel/preset-react", {
                development: debug
              }]
            ],
            plugins: [
              "@babel/plugin-transform-class-properties",
              "@babel/plugin-transform-object-rest-spread"
            ]
          },
        },
      }
    ]
  },

  optimization: debug ? undefined : {
    minimize: true,
    minimizer: [
      new MinimizerPlugin({
        parallel: true,
        extractComments: {
          banner: '@pow-faucet-client: ' + JSON.stringify({
            version: pkgJson.version,
            build: buildTime,
          }) + "\n",
        },
        minimizerOptions: {
          compress: true,
          keep_fnames: false,
          mangle: true,
          toplevel: true,
          module: true,
        }
      }),
    ],
  },

  plugins: [
    new webpack.DefinePlugin({
      FAUCET_CLIENT_VERSION: JSON.stringify(pkgJson.version),
      FAUCET_CLIENT_BUILDTIME: buildTime,
    }),
    new Visualizer({
      filename: 'webpack-stats.html'
    })
  ]
};



let finalModuleConfigs = webpackModuleConfigs.map(function(moduleConfig) {
  return wpmerge.merge(webpackBaseConfig, moduleConfig);
});

export default finalModuleConfigs;
