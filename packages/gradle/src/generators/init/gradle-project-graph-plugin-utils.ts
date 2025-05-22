import { globAsync, logger, Tree } from '@nx/devkit';
import {
  gradleProjectGraphPluginName,
  gradleProjectGraphVersion,
} from '../../utils/versions';
import { dirname, join } from 'path';

/**
 * Adds a `build.gradle(.kts)` file next to each `settings.gradle(.kts)` file found in the workspace.
 * If the build.gradle file already exists, it reads its contents.
 */
export async function addBuildGradleFileNextToSettingsGradle(
  tree: Tree
): Promise<{ filePath: string; content: string }[]> {
  const settingsGradleFiles = await globAsync(tree, [
    '**/settings.gradle',
    '**/settings.gradle.kts',
  ]);

  return settingsGradleFiles.map((settingsGradlePath) => {
    return ensureBuildGradleFile(tree, settingsGradlePath);
  });
}

/**
 * Determines the appropriate build.gradle file path based on the settings file
 * and ensures it exists in the tree. Returns the path and contents.
 */
function ensureBuildGradleFile(
  tree: Tree,
  settingsGradlePath: string
): { filePath: string; content: string } {
  const isKotlinDsl = settingsGradlePath.endsWith('.kts');
  const buildGradleFile = join(
    dirname(settingsGradlePath),
    isKotlinDsl ? 'build.gradle.kts' : 'build.gradle'
  );

  let content = '';
  if (tree.exists(buildGradleFile)) {
    content = tree.read(buildGradleFile, 'utf-8');
  } else {
    tree.write(buildGradleFile, content);
  }

  return { filePath: buildGradleFile, content };
}

const regex =
  /(id\s*\(?["']dev\.nx\.gradle\.project-graph["']\)?\s*version\s*\(?["'])([^"']+)(["']\)?)/;

/**
 * Extract gradle plugin version from build.gradle file
 * @param gradleContent
 * @returns gradle version
 */
export function extractNxPluginVersion(gradleContent: string): string | null {
  const match = gradleContent.match(regex);
  return match ? match[2] : null;
}

/**
 * Updates the plugin version in the given Gradle file content.
 */
export function updateNxPluginVersion(
  content: string,
  newVersion: string
): string {
  return content.replace(regex, `$1${newVersion}$3`);
}

/**
 * Ensures all build.gradle(.kts) files use the expected version of dev.nx.gradle.project-graph.
 */
export async function addNxProjectGraphPlugin(
  tree: Tree,
  expectedVersion: string = gradleProjectGraphVersion
) {
  const files = await addBuildGradleFileNextToSettingsGradle(tree);

  files.forEach(({ filePath, content }) => {
    addNxProjectGraphPluginToBuildGradle(
      filePath,
      content,
      expectedVersion,
      tree
    );
  });
}

/**
 * Adds or updates the Nx Project Graph plugin in the build.gradle(.kts) file.
 * Ensures the correct version and applies the plugin to all projects.
 * Returns the updated build.gradle content.
 */
function addNxProjectGraphPluginToBuildGradle(
  gradleFilePath: string,
  buildGradleContent: string,
  expectedVersion: string = gradleProjectGraphVersion,
  tree: Tree
): string {
  const isKotlinDsl = gradleFilePath.endsWith('.kts');
  const nxProjectGraphReportPlugin = isKotlinDsl
    ? `id(\"${gradleProjectGraphPluginName}\") version(\"${expectedVersion}\")`
    : `id \"${gradleProjectGraphPluginName}\" version \"${expectedVersion}\"`;

  // Helper to add plugin to plugins block
  function addPluginToPluginsBlock(content: string): string {
    return content.replace(
      /plugins\s*\{/,
      `plugins {\n    ${nxProjectGraphReportPlugin}`
    );
  }

  // Helper to add plugins block if missing
  function addPluginsBlock(content: string): string {
    return `plugins {\n    ${nxProjectGraphReportPlugin}\n}\n${content}`;
  }

  // Helper to add plugin application to allprojects
  function addPluginToAllProjects(content: string): string {
    const applyPlugin = isKotlinDsl
      ? `plugin(\"${gradleProjectGraphPluginName}\")`
      : `plugin(\"${gradleProjectGraphPluginName}\")`;
    return `${content}\nallprojects {\n    apply {\n        ${applyPlugin}\n    }\n}`;
  }

  // 1. Ensure plugins block and correct plugin version
  if (buildGradleContent.includes('plugins {')) {
    if (buildGradleContent.includes(gradleProjectGraphPluginName)) {
      // Update version if needed
      const currentVersion = extractNxPluginVersion(buildGradleContent);
      if (currentVersion && currentVersion !== expectedVersion) {
        buildGradleContent = updateNxPluginVersion(
          buildGradleContent,
          expectedVersion
        );
      }
    } else {
      // Add plugin to plugins block
      buildGradleContent = addPluginToPluginsBlock(buildGradleContent);
    }
  } else {
    // Add plugins block if missing
    buildGradleContent = addPluginsBlock(buildGradleContent);
  }

  // 2. Ensure plugin is applied to all projects
  const applyPluginPattern = new RegExp(
    `plugin\(["']${gradleProjectGraphPluginName}["']\)`
  );
  if (buildGradleContent.includes('allprojects {')) {
    if (!applyPluginPattern.test(buildGradleContent)) {
      logger.warn(
        `Please add the ${gradleProjectGraphPluginName} plugin to your ${gradleFilePath}:\nallprojects {\n  apply {\n      plugin(\"${gradleProjectGraphPluginName}\")\n  }\n}`
      );
    }
  } else {
    buildGradleContent = addPluginToAllProjects(buildGradleContent);
  }

  // 3. Write and return updated content
  tree.write(gradleFilePath, buildGradleContent);
  return buildGradleContent;
}
