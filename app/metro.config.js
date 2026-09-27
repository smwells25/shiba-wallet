// Metro configuration for the Shiba Wallet app shell.
//
// The app directory is deliberately NOT a member of the repository's npm
// workspaces (the root package.json only lists packages/*). The engine
// packages are referenced as `file:` dependencies instead, which npm
// installs as symlinks (app/node_modules/@shiba-wallet/core ->
// ../../packages/core). Metro resolves symlinks to their real path, so two
// adjustments are needed for bundling to work:
//
// 1. watchFolders must include the repository root, so Metro watches and can
//    serve files that live outside the app directory (packages/core/dist and
//    the root node_modules).
// 2. resolver.nodeModulesPaths must include the root node_modules, because
//    the engine packages resolve their own dependencies (@noble/*, @scure/*)
//    from the workspace-hoisted node_modules at the repository root.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
