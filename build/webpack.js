// @flow
import type {NextConfig} from '../server/config'
import path from 'path'
import webpack from 'webpack'
import resolve from 'resolve'
import CaseSensitivePathPlugin from 'case-sensitive-paths-webpack-plugin'
import WriteFilePlugin from 'write-file-webpack-plugin'
import FriendlyErrorsWebpackPlugin from 'friendly-errors-webpack-plugin'
import WebpackBar from 'webpackbar'
import {getPages} from './webpack/utils'
import PagesPlugin from './webpack/plugins/pages-plugin'
import NextJsSsrImportPlugin from './webpack/plugins/nextjs-ssr-import'
import NextJsSSRModuleCachePlugin from './webpack/plugins/nextjs-ssr-module-cache'
import NextJsRequireCacheHotReloader from './webpack/plugins/nextjs-require-cache-hot-reloader'
import UnlinkFilePlugin from './webpack/plugins/unlink-file-plugin'
import PagesManifestPlugin from './webpack/plugins/pages-manifest-plugin'
import BuildManifestPlugin from './webpack/plugins/build-manifest-plugin'
import ChunkNamesPlugin from './webpack/plugins/chunk-names-plugin'
import { ReactLoadablePlugin } from './webpack/plugins/react-loadable-plugin'
import {SERVER_DIRECTORY, NEXT_PROJECT_ROOT, NEXT_PROJECT_ROOT_NODE_MODULES, NEXT_PROJECT_ROOT_DIST, DEFAULT_PAGES_DIR, REACT_LOADABLE_MANIFEST} from '../lib/constants'

// The externals config makes sure that
// on the server side when modules are
// in node_modules they don't get compiled by webpack
function externalsConfig (dir, isServer) {
  const externals = []

  if (!isServer) {
    return externals
  }

  externals.push((context, request, callback) => {
    resolve(request, { basedir: dir, preserveSymlinks: true }, (err, res) => {
      if (err) {
        return callback()
      }

      // Default pages have to be transpiled
      if (res.match(/node_modules[/\\]next[/\\]dist[/\\]pages/)) {
        return callback()
      }

      // Webpack itself has to be compiled because it doesn't always use module relative paths
      if (res.match(/node_modules[/\\]webpack/)) {
        return callback()
      }

      if (res.match(/node_modules[/\\].*\.js$/)) {
        return callback(null, `commonjs ${request}`)
      }

      callback()
    })
  })

  return externals
}

function optimizationConfig ({dir, dev, isServer, totalPages}) {
  if (isServer) {
    return {
      // runtimeChunk: 'single',
      splitChunks: false,
      minimize: false
    }
  }

  const config: any = {
    runtimeChunk: {
      name: 'static/commons/runtime.js'
    },
    splitChunks: false
  }

  if (dev) {
    return config
  }

  // Only enabled in production
  // This logic will create a commons bundle
  // with modules that are used in 50% of all pages
  return {
    ...config,
    splitChunks: {
      chunks: 'all',
      cacheGroups: {
        default: false,
        vendors: false,
        commons: {
          name: 'commons',
          chunks: 'all',
          minChunks: totalPages > 2 ? totalPages * 0.5 : 2
        }
      }
    }
  }
}

type BaseConfigContext = {|
  dev: boolean,
  isServer: boolean,
  buildId: string,
  config: NextConfig
|}

export default async function getBaseWebpackConfig (dir: string, {dev = false, isServer = false, buildId, config}: BaseConfigContext) {
  const defaultLoaders = {
    babel: {
      loader: 'next-babel-loader',
      options: {dev, isServer}
    },
    hotSelfAccept: {
      loader: 'hot-self-accept-loader',
      options: {
        include: [
          path.join(dir, 'pages')
        ],
        // All pages are javascript files. So we apply hot-self-accept-loader here to facilitate hot reloading of pages.
        // This makes sure plugins just have to implement `pageExtensions` instead of also implementing the loader
        extensions: new RegExp(`\\.+(${config.pageExtensions.join('|')})$`)
      }
    }
  }

  // Support for NODE_PATH
  const nodePathList = (process.env.NODE_PATH || '')
    .split(process.platform === 'win32' ? ';' : ':')
    .filter((p) => !!p)

  const outputPath = path.join(dir, config.distDir, isServer ? SERVER_DIRECTORY : '')
  const pagesEntries = await getPages(dir, {nextPagesDir: DEFAULT_PAGES_DIR, dev, isServer, pageExtensions: config.pageExtensions.join('|')})
  const totalPages = Object.keys(pagesEntries).length
  const clientEntries = !isServer ? {
    // Backwards compatibility
    'main.js': [],
    'static/commons/main.js': [
      path.join(NEXT_PROJECT_ROOT_DIST, 'client', (dev ? `next-dev` : 'next'))
    ].filter(Boolean)
  } : {}

  let webpackConfig = {
    mode: dev ? 'development' : 'production',
    devtool: dev ? 'cheap-module-source-map' : false,
    name: isServer ? 'server' : 'client',
    cache: true,
    target: isServer ? 'node' : 'web',
    externals: externalsConfig(dir, isServer),
    optimization: optimizationConfig({dir, dev, isServer, totalPages}),
    recordsPath: path.join(outputPath, 'records.json'),
    context: dir,
    // Kept as function to be backwards compatible
    entry: async () => {
      return {
        ...clientEntries,
        // Only _error and _document when in development. The rest is handled by on-demand-entries
        ...pagesEntries
      }
    },
    output: {
      path: outputPath,
      filename: ({chunk}) => {
        // Use `[name]-[chunkhash].js` in production
        if (!dev && (chunk.name === 'static/commons/main.js' || chunk.name === 'static/commons/runtime.js')) {
          return chunk.name.replace(/\.js$/, '-' + chunk.renderedHash + '.js')
        }
        return '[name]'
      },
      libraryTarget: 'commonjs2',
      hotUpdateChunkFilename: 'static/webpack/[id].[hash].hot-update.js',
      hotUpdateMainFilename: 'static/webpack/[hash].hot-update.json',
      // This saves chunks with the name given via `import()`
      chunkFilename: isServer ? `${dev ? '[name]' : '[chunkhash]'}.js` : `static/chunks/${dev ? '[name]' : '[chunkhash]'}.js`,
      strictModuleExceptionHandling: true
    },
    performance: { hints: false },
    resolve: {
      extensions: ['.js', '.jsx', '.json'],
      modules: [
        NEXT_PROJECT_ROOT_NODE_MODULES,
        'node_modules',
        ...nodePathList // Support for NODE_PATH environment variable
      ],
      alias: {
        next: NEXT_PROJECT_ROOT
      }
    },
    resolveLoader: {
      modules: [
        NEXT_PROJECT_ROOT_NODE_MODULES,
        'node_modules',
        path.join(__dirname, 'webpack', 'loaders'), // The loaders Next.js provides
        ...nodePathList // Support for NODE_PATH environment variable
      ]
    },
    module: {
      rules: [
        dev && !isServer && {
          test: defaultLoaders.hotSelfAccept.options.extensions,
          include: defaultLoaders.hotSelfAccept.options.include,
          use: defaultLoaders.hotSelfAccept
        },
        {
          test: /\.(js|jsx)$/,
          include: [dir],
          exclude: /node_modules/,
          use: defaultLoaders.babel
        }
      ].filter(Boolean)
    },
    plugins: [
      // This plugin makes sure `output.filename` is used for entry chunks
      new ChunkNamesPlugin(),
      !isServer && new ReactLoadablePlugin({
        filename: REACT_LOADABLE_MANIFEST
      }),
      new WebpackBar({
        name: isServer ? 'server' : 'client'
      }),
      dev && !isServer && new FriendlyErrorsWebpackPlugin(),
      new webpack.IgnorePlugin(/(precomputed)/, /node_modules.+(elliptic)/),
      // Even though require.cache is server only we have to clear assets from both compilations
      // This is because the client compilation generates the build manifest that's used on the server side
      dev && new NextJsRequireCacheHotReloader(),
      dev && !isServer && new webpack.HotModuleReplacementPlugin(),
      dev && new webpack.NoEmitOnErrorsPlugin(),
      dev && new UnlinkFilePlugin(),
      dev && new CaseSensitivePathPlugin(), // Since on macOS the filesystem is case-insensitive this will make sure your path are case-sensitive
      dev && new WriteFilePlugin({
        exitOnErrors: false,
        log: false,
        // required not to cache removed files
        useHashIndex: false
      }),
      new webpack.DefinePlugin({
        'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production')
      }),
      !dev && new webpack.optimize.ModuleConcatenationPlugin(),
      isServer && new PagesManifestPlugin(),
      !isServer && new BuildManifestPlugin(),
      !isServer && new PagesPlugin(),
      isServer && new NextJsSsrImportPlugin(),
      isServer && new NextJsSSRModuleCachePlugin({outputPath})
    ].filter(Boolean)
  }

  if (typeof config.webpack === 'function') {
    webpackConfig = config.webpack(webpackConfig, {dir, dev, isServer, buildId, config, defaultLoaders, totalPages})
  }

  // Backwards compat for `main.js` entry key
  const originalEntry = webpackConfig.entry
  webpackConfig.entry = async () => {
    const entry: any = {...await originalEntry()}

    // Server compilation doesn't have main.js
    if (typeof entry['main.js'] !== 'undefined') {
      entry['static/commons/main.js'] = [
        ...entry['main.js'],
        ...entry['static/commons/main.js']
      ]

      delete entry['main.js']
    }

    return entry
  }

  return webpackConfig
}
