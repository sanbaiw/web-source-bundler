export interface TestCase {
  name: string;
  run: () => Promise<void> | void;
}

export interface TestSuite {
  name: string;
  tests: TestCase[];
}

export async function runSuites(suites: TestSuite[]): Promise<void> {
  let passed = 0;
  const failures: { name: string; error: unknown }[] = [];

  for (const suite of suites) {
    for (const test of suite.tests) {
      const name = `${suite.name} > ${test.name}`;
      try {
        await test.run();
        passed += 1;
        console.log(`PASS ${name}`);
      } catch (error) {
        failures.push({ name, error });
        console.error(`FAIL ${name}`);
        console.error(error);
      }
    }
  }

  if (failures.length > 0) {
    console.error(
      `${failures.length} failed, ${passed} passed across ${suites.length} suites`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`${passed} tests passed across ${suites.length} suites`);
}
