import { RequestHandler } from 'express';
import { maxSatisfying } from 'semver';
import got from 'got';
import { NPMPackage } from './types';

type Package = { version: string; dependencies: Record<string, Package> };

/**
 * Attempts to retrieve package data from the npm registry and return it
 */
export const getPackage: RequestHandler = async function (req, res, next) {
  const { name, version } = req.params;
  const dependencyTree = {};
  try {
    const npmPackage: NPMPackage = await got(
      `https://registry.npmjs.org/${name}`,
    ).json();

    const dependencies: Record<string, string> =
      npmPackage.versions[version].dependencies ?? {};
    for (const [name, range] of Object.entries(dependencies)) {
      const subDep = await getDependencies(name, range);
      dependencyTree[name] = subDep;
    }

    return res
      .status(200)
      // review: A deep tree of JSON objects might not be the
      // easiest structure to work with as an HTTP API consumer. The body of
      // the response could become quite large, containing many duplicate packages;
      // an extreme example would be querying for the "everything" package.
      // idea: A flatter response structure might be preferrable, e.g. with each package
      // referring to another top-level object by name & version.
      .json({ name, version, dependencies: dependencyTree });
  } catch (error) {
    return next(error);
  }
};

async function getDependencies(name: string, range: string): Promise<Package> {
  // review: this could be refactored into a "registry service" to avoid code duplication
  // and improve extensibility. e.g. if this tool needs to support private registries in 
  // the future.
  const npmPackage: NPMPackage = await got(
    `https://registry.npmjs.org/${name}`,
  ).json();

  // review: this can result in cyclic depndency resolution when encountering
  // packages containing a dependency with '*' as the specified version.
  // The "everything" package is again a good example.
  // 'everything': { 'some-other-dependency': '*' }
  // 'some-other-dependency': { 'everything': '*' }
  const v = maxSatisfying(Object.keys(npmPackage.versions), range);
  const dependencies: Record<string, Package> = {};

  if (v) {
    const newDeps = npmPackage.versions[v].dependencies;
    // review: Sequentially fetching dependencies will cause a
    // networking bottleneck. It may be better to fetch dependencies
    // concurrently (up to a max amount depending on NPM's rate limits).
    // idea: Traverse dependencies in breadth-first order, collecting the unique
    // name-version pairs into a queue while enforcing uniqueness. While keeping
    // track of the already-fetched (visited) dependencies as a cache,
    // from the queue, fetch the next level of dependencies concurrently
    // (possibly in batches), referencing the cache when a dependency is already
    // visited.
    // idea: depending on the expected load for this web server, an additional caching
    // layer might be appropraite to support multiple instances of the web server
    // sharing the same cache.
    for (const [name, range] of Object.entries(newDeps ?? {})) {
      // review: recusively traversing dependencies without maintaining
      // an accumulator for the already-fetched dependencies will result
      // in duplicated requests to NPM's APIs.
      // A dependency cycle could also be resolved using an accumulator. 
      dependencies[name] = await getDependencies(name, range);
    }
  }

  // review: If a version satisfying the range is not found, dependencies
  // will be an empty object. This behavior might be confusing for callers of
  // this funciton. Rejecting the promise or another, distinct result type is
  // probably more appropriate.
  return { version: v ?? range, dependencies };
}
