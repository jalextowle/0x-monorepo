import * as fs from 'fs';
import * as Mocha from 'mocha';
import * as path from 'path';

const DEFAULT_TEST_DIRECTORY = 'lib/test/';

export async function testAsync(testDirectory?: string): Promise<void> {
    // Instantiate a Mocha instance.
    const mocha = new Mocha();

    // If a testDir was not given, use the default.
    const testDir = testDirectory || DEFAULT_TEST_DIRECTORY;

    // Add each .js file to the mocha instance
    fs.readdirSync(testDir)
        .filter(function(file) {
            // Only keep the .js files
            return file.substr(-3) === '.js';
        })
        .forEach(function(file) {
            mocha.addFile(path.join(testDir, file));
        });

    // Run the tests.
    mocha.run(function(failures) {
        process.exitCode = failures ? 1 : 0; // exit with non-zero status if there were failures
    });
}
