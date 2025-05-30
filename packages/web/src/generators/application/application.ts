import {
  addDependenciesToPackageJson,
  addProjectConfiguration,
  ensurePackage,
  formatFiles,
  generateFiles,
  GeneratorCallback,
  getPackageManagerCommand,
  joinPathFragments,
  names,
  offsetFromRoot,
  type PluginConfiguration,
  readNxJson,
  readProjectConfiguration,
  runTasksInSerial,
  Tree,
  updateJson,
  updateNxJson,
  updateProjectConfiguration,
  writeJson,
} from '@nx/devkit';
import {
  determineProjectNameAndRootOptions,
  ensureRootProjectName,
} from '@nx/devkit/src/generators/project-name-and-root-utils';
import {
  getRelativePathToRootTsConfig,
  initGenerator as jsInitGenerator,
} from '@nx/js';
import { swcCoreVersion } from '@nx/js/src/utils/versions';
import { join } from 'path';
import {
  nxVersion,
  swcLoaderVersion,
  tsLibVersion,
  typesNodeVersion,
} from '../../utils/versions';
import { webInitGenerator } from '../init/init';
import { Schema } from './schema';
import { getNpmScope } from '@nx/js/src/utils/package-json/get-npm-scope';
import { hasWebpackPlugin } from '../../utils/has-webpack-plugin';
import { addBuildTargetDefaults } from '@nx/devkit/src/generators/target-defaults-utils';
import { logShowProjectCommand } from '@nx/devkit/src/utils/log-show-project-command';
import staticServeConfiguration from '../static-serve/static-serve-configuration';
import { E2EWebServerDetails } from '@nx/devkit/src/generators/e2e-web-server-info-utils';
import {
  addProjectToTsSolutionWorkspace,
  isUsingTsSolutionSetup,
  updateTsconfigFiles,
} from '@nx/js/src/utils/typescript/ts-solution-setup';
import type { PackageJson } from 'nx/src/utils/package-json';

interface NormalizedSchema extends Schema {
  projectName: string;
  importPath: string;
  appProjectRoot: string;
  e2eProjectName: string;
  e2eProjectRoot: string;
  names: ReturnType<typeof names>;
  parsedTags: string[];
  isUsingTsSolutionConfig: boolean;
}

function createApplicationFiles(tree: Tree, options: NormalizedSchema) {
  const rootTsConfigPath = getRelativePathToRootTsConfig(
    tree,
    options.appProjectRoot
  );
  if (options.bundler === 'vite') {
    generateFiles(
      tree,
      join(__dirname, './files/app-vite'),
      options.appProjectRoot,
      {
        ...options,
        tmpl: '',
        offsetFromRoot: offsetFromRoot(options.appProjectRoot),
        rootTsConfigPath,
      }
    );
  } else {
    const rootOffset = offsetFromRoot(options.appProjectRoot);
    generateFiles(
      tree,
      join(__dirname, './files/app-webpack'),
      options.appProjectRoot,
      {
        ...options,
        tmpl: '',
        offsetFromRoot: rootOffset,
        rootTsConfigPath,
        webpackPluginOptions: hasWebpackPlugin(tree)
          ? {
              compiler: options.compiler,
              target: 'web',
              outputPath: options.isUsingTsSolutionConfig
                ? 'dist'
                : joinPathFragments(
                    rootOffset,
                    'dist',
                    options.appProjectRoot !== '.'
                      ? options.appProjectRoot
                      : options.projectName
                  ),
              tsConfig: './tsconfig.app.json',
              main: './src/main.ts',
              assets: ['./src/favicon.ico', './src/assets'],
              index: './src/index.html',
              baseHref: '/',
              styles: [`./src/styles.${options.style}`],
            }
          : null,
      }
    );
    if (options.unitTestRunner === 'none') {
      tree.delete(
        join(options.appProjectRoot, './src/app/app.element.spec.ts')
      );
    }
  }
  if (options.isUsingTsSolutionConfig) {
    updateJson(
      tree,
      joinPathFragments(options.appProjectRoot, 'tsconfig.json'),
      () => ({
        extends: rootTsConfigPath,
        files: [],
        include: [],
        references: [
          {
            path: './tsconfig.app.json',
          },
        ],
      })
    );
  } else {
    updateJson(
      tree,
      joinPathFragments(options.appProjectRoot, 'tsconfig.json'),
      (json) => {
        return {
          ...json,
          compilerOptions: {
            ...(json.compilerOptions || {}),
            strict: options.strict,
          },
        };
      }
    );
  }
}

async function setupBundler(tree: Tree, options: NormalizedSchema) {
  const main = joinPathFragments(options.appProjectRoot, 'src/main.ts');
  const tsConfig = joinPathFragments(
    options.appProjectRoot,
    'tsconfig.app.json'
  );
  const assets = [
    joinPathFragments(options.appProjectRoot, 'src/favicon.ico'),
    joinPathFragments(options.appProjectRoot, 'src/assets'),
  ];

  if (options.bundler === 'webpack') {
    const { configurationGenerator } = ensurePackage<
      typeof import('@nx/webpack')
    >('@nx/webpack', nxVersion);
    await configurationGenerator(tree, {
      target: 'web',
      project: options.projectName,
      main,
      tsConfig,
      compiler: options.compiler ?? 'babel',
      devServer: true,
      webpackConfig: joinPathFragments(
        options.appProjectRoot,
        'webpack.config.js'
      ),
      skipFormat: true,
      addPlugin: options.addPlugin,
    });
    const project = readProjectConfiguration(tree, options.projectName);
    if (project.targets?.build) {
      const prodConfig = project.targets.build.configurations.production;
      const buildOptions = project.targets.build.options;
      buildOptions.assets = assets;
      buildOptions.index = joinPathFragments(
        options.appProjectRoot,
        'src/index.html'
      );
      buildOptions.baseHref = '/';
      buildOptions.styles = [
        joinPathFragments(
          options.appProjectRoot,
          `src/styles.${options.style}`
        ),
      ];
      // We can delete that, because this projest is an application
      // and applications have a .babelrc file in their root dir.
      // So Nx will find it and use it
      delete buildOptions.babelUpwardRootMode;
      buildOptions.scripts = [];
      prodConfig.fileReplacements = [
        {
          replace: joinPathFragments(
            options.appProjectRoot,
            `src/environments/environment.ts`
          ),
          with: joinPathFragments(
            options.appProjectRoot,
            `src/environments/environment.prod.ts`
          ),
        },
      ];
      prodConfig.optimization = true;
      prodConfig.outputHashing = 'all';
      prodConfig.sourceMap = false;
      prodConfig.namedChunks = false;
      prodConfig.extractLicenses = true;
      prodConfig.vendorChunk = false;
      updateProjectConfiguration(tree, options.projectName, project);
    }
    // TODO(jack): Flush this out... no bundler should be possible for web but the experience isn't holistic due to missing features (e.g. writing index.html).
  } else if (options.bundler === 'none') {
    const project = readProjectConfiguration(tree, options.projectName);
    addBuildTargetDefaults(tree, `@nx/js:${options.compiler}`);
    project.targets ??= {};
    project.targets.build = {
      executor: `@nx/js:${options.compiler}`,
      outputs: ['{options.outputPath}'],
      options: {
        main,
        outputPath: joinPathFragments('dist', options.appProjectRoot),
        tsConfig,
      },
    };
    updateProjectConfiguration(tree, options.projectName, project);
  } else {
    throw new Error('Unsupported bundler type');
  }
}

async function addProject(tree: Tree, options: NormalizedSchema) {
  const packageJson: PackageJson = {
    name: options.importPath,
    version: '0.0.1',
    private: true,
  };

  if (!options.useProjectJson) {
    if (options.projectName !== options.importPath) {
      packageJson.nx = { name: options.projectName };
    }
    if (options.parsedTags?.length) {
      packageJson.nx ??= {};
      packageJson.nx.tags = options.parsedTags;
    }
  } else {
    addProjectConfiguration(tree, options.projectName, {
      projectType: 'application',
      root: options.appProjectRoot,
      sourceRoot: joinPathFragments(options.appProjectRoot, 'src'),
      tags: options.parsedTags,
      targets: {},
    });
  }

  if (!options.useProjectJson || options.isUsingTsSolutionConfig) {
    writeJson(
      tree,
      joinPathFragments(options.appProjectRoot, 'package.json'),
      packageJson
    );
  }
}

function setDefaults(tree: Tree, options: NormalizedSchema) {
  const nxJson = readNxJson(tree);
  nxJson.generators = nxJson.generators || {};
  nxJson.generators['@nx/web:application'] = {
    style: options.style,
    linter: options.linter,
    unitTestRunner: options.unitTestRunner,
    e2eTestRunner: options.e2eTestRunner,
    ...nxJson.generators['@nx/web:application'],
  };
  updateNxJson(tree, nxJson);
}

export async function applicationGenerator(host: Tree, schema: Schema) {
  return await applicationGeneratorInternal(host, {
    addPlugin: false,
    ...schema,
  });
}

export async function applicationGeneratorInternal(host: Tree, schema: Schema) {
  const options = await normalizeOptions(host, schema);

  if (options.isUsingTsSolutionConfig) {
    await addProjectToTsSolutionWorkspace(host, options.appProjectRoot);
  }

  const tasks: GeneratorCallback[] = [];

  const jsInitTask = await jsInitGenerator(host, {
    js: false,
    skipFormat: true,
    platform: 'web',
  });
  tasks.push(jsInitTask);
  const webTask = await webInitGenerator(host, {
    ...options,
    skipFormat: true,
  });
  tasks.push(webTask);

  await addProject(host, options);

  if (options.bundler !== 'vite') {
    await setupBundler(host, options);
  }

  createApplicationFiles(host, options);

  if (options.linter === 'eslint') {
    const { lintProjectGenerator } = ensurePackage<typeof import('@nx/eslint')>(
      '@nx/eslint',
      nxVersion
    );
    const lintTask = await lintProjectGenerator(host, {
      linter: options.linter,
      project: options.projectName,
      tsConfigPaths: [
        joinPathFragments(options.appProjectRoot, 'tsconfig.app.json'),
      ],
      unitTestRunner: options.unitTestRunner,
      skipFormat: true,
      setParserOptionsProject: options.setParserOptionsProject,
      addPlugin: options.addPlugin,
    });
    tasks.push(lintTask);
  }

  if (options.bundler === 'vite') {
    const { viteConfigurationGenerator, createOrEditViteConfig } =
      ensurePackage<typeof import('@nx/vite')>('@nx/vite', nxVersion);
    // We recommend users use `import.meta.env.MODE` and other variables in their code to differentiate between production and development.
    // See: https://vitejs.dev/guide/env-and-mode.html
    if (
      host.exists(joinPathFragments(options.appProjectRoot, 'src/environments'))
    ) {
      host.delete(
        joinPathFragments(options.appProjectRoot, 'src/environments')
      );
    }

    const viteTask = await viteConfigurationGenerator(host, {
      uiFramework: 'none',
      project: options.projectName,
      newProject: true,
      includeVitest: options.unitTestRunner === 'vitest',
      inSourceTests: options.inSourceTests,
      skipFormat: true,
      addPlugin: options.addPlugin,
    });
    tasks.push(viteTask);
    createOrEditViteConfig(
      host,
      {
        project: options.projectName,
        includeLib: false,
        includeVitest: options.unitTestRunner === 'vitest',
        inSourceTests: options.inSourceTests,
      },
      false
    );
  }

  if (options.bundler !== 'vite' && options.unitTestRunner === 'vitest') {
    const { vitestGenerator, createOrEditViteConfig } = ensurePackage<
      typeof import('@nx/vite')
    >('@nx/vite', nxVersion);
    const vitestTask = await vitestGenerator(host, {
      uiFramework: 'none',
      project: options.projectName,
      coverageProvider: 'v8',
      inSourceTests: options.inSourceTests,
      skipFormat: true,
      addPlugin: options.addPlugin,
      compiler: options.compiler,
    });
    tasks.push(vitestTask);
    createOrEditViteConfig(
      host,
      {
        project: options.projectName,
        includeLib: false,
        includeVitest: true,
        inSourceTests: options.inSourceTests,
      },
      true
    );
  }

  if (
    (options.bundler === 'vite' || options.unitTestRunner === 'vitest') &&
    options.inSourceTests
  ) {
    host.delete(
      joinPathFragments(options.appProjectRoot, `src/app/app.element.spec.ts`)
    );
  }

  const nxJson = readNxJson(host);
  let hasPlugin: PluginConfiguration | undefined;
  let buildPlugin: string;
  let buildConfigFile: string;
  if (options.bundler === 'webpack' || options.bundler === 'vite') {
    buildPlugin = `@nx/${options.bundler}/plugin`;
    buildConfigFile =
      options.bundler === 'webpack' ? 'webpack.config.js' : `vite.config.ts`;
    hasPlugin = nxJson.plugins?.find((p) =>
      typeof p === 'string' ? p === buildPlugin : p.plugin === buildPlugin
    );
  }

  if (!hasPlugin) {
    await staticServeConfiguration(host, {
      buildTarget: `${options.projectName}:build`,
      spa: true,
    });
  }

  let e2eWebServerInfo: E2EWebServerDetails = {
    e2eWebServerAddress: `http://localhost:4200`,
    e2eWebServerCommand: `${getPackageManagerCommand().exec} nx run ${
      options.projectName
    }:serve`,
    e2eCiWebServerCommand: `${getPackageManagerCommand().exec} nx run ${
      options.projectName
    }:serve-static`,
    e2eCiBaseUrl: `http://localhost:4200`,
    e2eDevServerTarget: `${options.projectName}:serve`,
  };

  if (options.bundler === 'webpack') {
    const { getWebpackE2EWebServerInfo } = ensurePackage<
      typeof import('@nx/webpack')
    >('@nx/webpack', nxVersion);
    e2eWebServerInfo = await getWebpackE2EWebServerInfo(
      host,
      options.projectName,
      joinPathFragments(options.appProjectRoot, `webpack.config.js`),
      options.addPlugin,
      4200
    );
  } else if (options.bundler === 'vite') {
    const { getViteE2EWebServerInfo } = ensurePackage<
      typeof import('@nx/vite')
    >('@nx/vite', nxVersion);
    e2eWebServerInfo = await getViteE2EWebServerInfo(
      host,
      options.projectName,
      joinPathFragments(options.appProjectRoot, `vite.config.ts`),
      options.addPlugin,
      4200
    );
  }

  if (options.e2eTestRunner === 'cypress') {
    const { configurationGenerator } = ensurePackage<
      typeof import('@nx/cypress')
    >('@nx/cypress', nxVersion);

    const packageJson: PackageJson = {
      name: options.e2eProjectName,
      version: '0.0.1',
      private: true,
    };

    if (!options.useProjectJson) {
      packageJson.nx = {
        implicitDependencies: [options.projectName],
      };
    } else {
      addProjectConfiguration(host, options.e2eProjectName, {
        root: options.e2eProjectRoot,
        sourceRoot: joinPathFragments(options.e2eProjectRoot, 'src'),
        projectType: 'application',
        targets: {},
        tags: [],
        implicitDependencies: [options.projectName],
      });
    }

    if (!options.useProjectJson || options.isUsingTsSolutionConfig) {
      writeJson(
        host,
        joinPathFragments(options.e2eProjectRoot, 'package.json'),
        packageJson
      );
    }

    const cypressTask = await configurationGenerator(host, {
      ...options,
      project: options.e2eProjectName,
      devServerTarget: e2eWebServerInfo.e2eDevServerTarget,
      baseUrl: e2eWebServerInfo.e2eWebServerAddress,
      directory: 'src',
      skipFormat: true,
      webServerCommands: {
        default: e2eWebServerInfo.e2eWebServerCommand,
        production: e2eWebServerInfo.e2eCiWebServerCommand,
      },
      ciWebServerCommand: e2eWebServerInfo.e2eCiWebServerCommand,
      ciBaseUrl: e2eWebServerInfo.e2eCiBaseUrl,
    });

    tasks.push(cypressTask);
  } else if (options.e2eTestRunner === 'playwright') {
    const { configurationGenerator: playwrightConfigGenerator } = ensurePackage<
      typeof import('@nx/playwright')
    >('@nx/playwright', nxVersion);

    const packageJson: PackageJson = {
      name: options.e2eProjectName,
      version: '0.0.1',
      private: true,
    };

    if (!options.useProjectJson) {
      packageJson.nx = {
        implicitDependencies: [options.projectName],
      };
    } else {
      addProjectConfiguration(host, options.e2eProjectName, {
        root: options.e2eProjectRoot,
        sourceRoot: joinPathFragments(options.e2eProjectRoot, 'src'),
        projectType: 'application',
        targets: {},
        tags: [],
        implicitDependencies: [options.projectName],
      });
    }

    if (!options.useProjectJson || options.isUsingTsSolutionConfig) {
      writeJson(
        host,
        joinPathFragments(options.e2eProjectRoot, 'package.json'),
        packageJson
      );
    }

    const playwrightTask = await playwrightConfigGenerator(host, {
      project: options.e2eProjectName,
      skipFormat: true,
      skipPackageJson: false,
      directory: 'src',
      js: false,
      linter: options.linter,
      setParserOptionsProject: options.setParserOptionsProject,
      webServerCommand: e2eWebServerInfo.e2eCiWebServerCommand,
      webServerAddress: e2eWebServerInfo.e2eCiBaseUrl,
      addPlugin: options.addPlugin,
    });

    tasks.push(playwrightTask);
  }
  if (options.unitTestRunner === 'jest') {
    const { configurationGenerator } = ensurePackage<typeof import('@nx/jest')>(
      '@nx/jest',
      nxVersion
    );
    const jestTask = await configurationGenerator(host, {
      project: options.projectName,
      skipSerializers: true,
      setupFile: 'web-components',
      compiler: options.compiler,
      skipFormat: true,
      addPlugin: options.addPlugin,
    });
    tasks.push(jestTask);
  }

  if (options.compiler === 'swc') {
    writeJson(host, joinPathFragments(options.appProjectRoot, '.swcrc'), {
      jsc: {
        parser: {
          syntax: 'typescript',
        },
        target: 'es2016',
      },
    });
    const installTask = addDependenciesToPackageJson(
      host,
      {},
      { '@swc/core': swcCoreVersion, 'swc-loader': swcLoaderVersion }
    );
    tasks.push(installTask);
  } else {
    writeJson(host, joinPathFragments(options.appProjectRoot, '.babelrc'), {
      presets: ['@nx/js/babel'],
    });
  }

  setDefaults(host, options);

  tasks.push(
    addDependenciesToPackageJson(
      host,
      { tslib: tsLibVersion },
      { '@types/node': typesNodeVersion }
    )
  );

  updateTsconfigFiles(
    host,
    options.appProjectRoot,
    'tsconfig.app.json',
    {
      module: 'esnext',
      moduleResolution: 'bundler',
    },
    options.linter === 'eslint'
      ? ['eslint.config.js', 'eslint.config.cjs', 'eslint.config.mjs']
      : undefined
  );

  if (!options.skipFormat) {
    await formatFiles(host);
  }

  tasks.push(() => {
    logShowProjectCommand(options.projectName);
  });

  return runTasksInSerial(...tasks);
}

async function normalizeOptions(
  host: Tree,
  options: Schema
): Promise<NormalizedSchema> {
  await ensureRootProjectName(options, 'application');
  const {
    projectName,
    projectRoot: appProjectRoot,
    importPath,
  } = await determineProjectNameAndRootOptions(host, {
    name: options.name,
    projectType: 'application',
    directory: options.directory,
  });
  const nxJson = readNxJson(host);
  const addPluginDefault =
    process.env.NX_ADD_PLUGINS !== 'false' &&
    nxJson.useInferencePlugins !== false;
  options.addPlugin ??= addPluginDefault;

  const isUsingTsSolutionConfig = isUsingTsSolutionSetup(host);
  const appProjectName =
    !isUsingTsSolutionConfig || options.name ? projectName : importPath;

  const e2eProjectName = `${appProjectName}-e2e`;
  const e2eProjectRoot = `${appProjectRoot}-e2e`;

  const npmScope = getNpmScope(host);

  const parsedTags = options.tags
    ? options.tags.split(',').map((s) => s.trim())
    : [];

  options.style = options.style || 'css';
  options.linter = options.linter || 'eslint';
  options.unitTestRunner = options.unitTestRunner || 'jest';
  options.e2eTestRunner = options.e2eTestRunner || 'playwright';

  return {
    ...options,
    prefix: options.prefix ?? npmScope ?? 'app',
    compiler: options.compiler ?? 'babel',
    bundler: options.bundler ?? 'webpack',
    projectName: appProjectName,
    importPath,
    strict: options.strict ?? true,
    appProjectRoot,
    e2eProjectRoot,
    e2eProjectName,
    parsedTags,
    names: names(projectName),
    isUsingTsSolutionConfig,
    useProjectJson: options.useProjectJson ?? !isUsingTsSolutionConfig,
  };
}

export default applicationGenerator;
