import * as vscode from 'vscode';
import { TestSuiteInfo, TestInfo, TestRunStartedEvent, TestRunFinishedEvent, TestSuiteEvent, TestEvent } from 'vscode-test-adapter-api';
import * as childProcess from 'child_process';
import * as split2 from 'split2';
import { Log } from 'vscode-test-adapter-util';

export abstract class Tests {
  protected context: vscode.ExtensionContext;
  protected testStatesEmitter: vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>;
  protected currentChildProcess: childProcess.ChildProcess | undefined;
  protected log: Log;
  protected testSuite: TestSuiteInfo | undefined;
  protected workspace: vscode.WorkspaceFolder;
  abstract testFrameworkName: string;
  protected debugCommandStartedResolver: Function | undefined;

  /**
   * @param context Extension context provided by vscode.
   * @param testStatesEmitter An emitter for the test suite's state.
   * @param log The Test Adapter logger, for logging.
   */
  constructor(
    context: vscode.ExtensionContext,
    testStatesEmitter: vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>,
    log: Log,
    workspace: vscode.WorkspaceFolder
  ) {
    this.context = context;
    this.testStatesEmitter = testStatesEmitter;
    this.log = log;
    this.workspace = workspace;
  }

  abstract tests: () => Promise<TestSuiteInfo>;

  abstract initTests: () => Promise<string>;

  /**
   * Takes the output from initTests() and parses the resulting
   * JSON into a TestSuiteInfo object.
   *
   * @return The full test suite.
   */
  public async loadTests(): Promise<TestSuiteInfo> {
    let output = await this.initTests();
    this.log.debug('Passing raw output from dry-run into getJsonFromOutput.');
    this.log.debug(`${output}`);
    output = Tests.getJsonFromOutput(output);
    this.log.debug('Parsing the below JSON:');
    this.log.debug(`${output}`);
    let testMetadata;
    try {
      testMetadata = JSON.parse(output);
    } catch (error) {
      this.log.error(`JSON parsing failed: ${error}`);
    }

    let tests: Array<{ id: string; full_description: string; description: string; file_path: string; line_number: number; location: number; }> = [];

    testMetadata.examples.forEach((test: { id: string; full_description: string; description: string; file_path: string; line_number: number; location: number; }) => {
      let test_location_array: Array<string> = test.id.substring(test.id.indexOf("[") + 1, test.id.lastIndexOf("]")).split(':');
      let test_location_string: string = test_location_array.join('');
      test.location = parseInt(test_location_string);
      tests.push(test);
    });

    let testSuite: TestSuiteInfo = await this.getBaseTestSuite(tests);
    this.testSuite = testSuite;

    return Promise.resolve<TestSuiteInfo>(testSuite);
  }

  /**
   * Kills the current child process if one exists.
   */
  public killChild(): void {
    if (this.currentChildProcess) {
      this.currentChildProcess.kill();
    }
  }

  /**
  * Get the user-configured test file pattern.
  *
  * @return The file pattern
  */
  getFilePattern(): Array<string> {
    let pattern: Array<string> = (vscode.workspace.getConfiguration('rubyTestExplorer', null).get('filePattern') as Array<string>);
    return pattern || ['*_test.rb', 'test_*.rb'];
  }

  /**
   * Get the user-configured test directory, if there is one.
   *
   * @return The test directory
   */
  abstract getTestDirectory(): string;

  /**
   * Pull JSON out of the test framework output.
   *
   * RSpec and Minitest frequently return bad data even when they're told to
   * format the output as JSON, e.g. due to code coverage messages and other
   * injections from gems. This gets the JSON by searching for
   * `START_OF_TEST_JSON` and an opening curly brace, as well as a closing
   * curly brace and `END_OF_TEST_JSON`. These are output by the custom
   * RSpec formatter or Minitest Rake task as part of the final JSON output.
   *
   * @param output The output returned by running a command.
   * @return A string representation of the JSON found in the output.
   */
  static getJsonFromOutput(output: string): string {
    output = output.substring(output.indexOf('START_OF_TEST_JSON{'), output.lastIndexOf('}END_OF_TEST_JSON') + 1);
    // Get rid of the `START_OF_TEST_JSON` and `END_OF_TEST_JSON` to verify that the JSON is valid.
    return output.substring(output.indexOf("{"), output.lastIndexOf("}") + 1);
  }

  /**
   * Get the location of the test in the testing tree.
   *
   * Test ids are in the form of `/spec/model/game_spec.rb[1:1:1]`, and this
   * function turns that into `111`. The number is used to order the tests
   * in the explorer.
   *
   * @param test The test we want to get the location of.
   * @return A number representing the location of the test in the test tree.
   */
  protected getTestLocation(test: TestInfo): number {
    return parseInt(test.id.substring(test.id.indexOf("[") + 1, test.id.lastIndexOf("]")).split(':').join(''));
  }

  /**
   * Convert a string from snake_case to PascalCase.
   * Note that the function will return the input string unchanged if it
   * includes a '/'.
   *
   * @param string The string to convert to PascalCase.
   * @return The converted string.
   */
  protected snakeToPascalCase(string: string): string {
    if (string.includes('/')) { return string }
    return string.split("_").map(substr => substr.charAt(0).toUpperCase() + substr.slice(1)).join("");
  }

  /**
   * 
   * @param suite A TestSuiteInfo obejct which children needds to be sorted.
   */
  protected sortChildren(suite: TestSuiteInfo) {
    if(!suite.children && typeof suite.children[Symbol.iterator] === 'function') return;
    
    if (suite.children.some(x => x.type === "test")) {
      suite.children = this.sortTestsChildren(suite.children as Array<TestInfo>);
      return;
    } 
   
    suite.children = this.sortTestSuiteChildren(suite.children as Array<TestSuiteInfo>);
    suite.children.forEach(t => this.sortChildren(t as TestSuiteInfo));
  }

  /**
   * 
   * @param testChildren An array of TestInfo objects, general the childeren of a suite if it is a file
   * @returns The input array, sorted by location
   */
  protected sortTestsChildren(testChildren: Array<TestInfo>): Array<TestInfo> {
    testChildren = testChildren.sort((a: TestInfo, b: TestInfo) => {
      if ((a as TestInfo).type === "test" && (b as TestInfo).type === "test") {
        let aLocation: number = this.getTestLocation(a as TestInfo);
        let bLocation: number = this.getTestLocation(b as TestInfo);
        return aLocation - bLocation;
      } else {
        return 0;
      }
    });

    return testChildren;
  }

  /**
   * Sorts an array of TestSuiteInfo objects by label.
   *
   * @param testSuiteChildren An array of TestSuiteInfo objects, generally the children of another TestSuiteInfo object.
   * @return The input array, sorted by label.
   */
  protected sortTestSuiteChildren(testSuiteChildren: Array<TestSuiteInfo>): Array<TestSuiteInfo> {
    if(!testSuiteChildren) return [];

    testSuiteChildren = testSuiteChildren.sort((a: TestSuiteInfo, b: TestSuiteInfo) => {
      if(a.label.endsWith(".rb")) return 1;

      if (a.label > b.label) {
        return -1;
      } else if (a.label < b.label) {
        return 1;
      }

      return 0;
    });

    return testSuiteChildren;
  }

  /**
   * Get the tests in a given file.
   */
  public getTestSuiteForFile(
    { tests, currentFile, label }: {
      tests: Array<{
        id: string;
        full_description: string;
        description: string;
        file_path: string;
        line_number: number;
        location: number;
      }>; currentFile: string; label?: string;
    }): TestSuiteInfo {
    let currentFileTests = tests.filter(test => {
      return test.file_path === currentFile
    });

    let currentFileTestsInfo = currentFileTests as unknown as Array<TestInfo>;
    currentFileTestsInfo.forEach((test: TestInfo) => {
      test.type = 'test';
      test.label = '';
    });

    let currentFileLabel = label || currentFile.split("/").slice(-1)[0];

    let pascalCurrentFileLabel = this.snakeToPascalCase(currentFileLabel.replace('_spec.rb', ''));

    let currentFileTestInfoArray: Array<TestInfo> = currentFileTests.map((test) => {
      // Concatenation of "/Users/username/whatever/project_dir" and "./spec/path/here.rb",
      // but with the latter's first character stripped.
      let filePath: string = `${this.workspace.uri.fsPath}${test.file_path.substr(1)}`;

      // RSpec provides test ids like "file_name.rb[1:2:3]".
      // This uses the digits at the end of the id to create
      // an array of numbers representing the location of the
      // test in the file.
      let testLocationArray: Array<number> = test.id.substring(test.id.indexOf("[") + 1, test.id.lastIndexOf("]")).split(':').map((x) => {
        return parseInt(x);
      });

      // Get the last element in the location array.
      let testNumber: number = testLocationArray[testLocationArray.length - 1];
      // If the test doesn't have a name (because it uses the 'it do' syntax), "test #n"
      // is appended to the test description to distinguish between separate tests.
      let description: string = test.description.startsWith('example at ') ? `${test.full_description}test #${testNumber}` : test.full_description;

      // If the current file label doesn't have a slash in it and it starts with the PascalCase'd
      // file name, remove the from the start of the description. This turns, e.g.
      // `ExternalAccount Validations blah blah blah' into 'Validations blah blah blah'.
      if (!pascalCurrentFileLabel.includes('/') && description.startsWith(pascalCurrentFileLabel)) {
        // Optional check for a space following the PascalCase file name. In some
        // cases, e.g. 'FileName#method_name` there's no space after the file name.
        let regexString = `${pascalCurrentFileLabel}[ ]?`;
        let regex = new RegExp(regexString, "g");
        description = description.replace(regex, '');
      }

      let testInfo: TestInfo = {
        type: 'test',
        id: test.id,
        label: description,
        file: filePath,
        // Line numbers are 0-indexed
        line: test.line_number - 1,
        tooltip: description
      }

      return testInfo;
    });

    let currentFileAsAbsolutePath = `${this.workspace.uri.fsPath}${currentFile.substr(1)}`;

    let currentFileTestSuite: TestSuiteInfo = {
      type: 'suite',
      id: currentFile,
      label: currentFileLabel,
      file: currentFileAsAbsolutePath,
      children: currentFileTestInfoArray,
      tooltip: currentFile.replace(this.getTestDirectory(), '')
    }

    return currentFileTestSuite;
  }

  /**
   * Create the base test suite with a root node and one layer of child nodes
   * representing the subdirectories of spec/, and then any files under the
   * given subdirectory.
   *
   * @param tests Test objects returned by our custom RSpec formatter or Minitest Rake task.
   * @return The test suite root with its children.
   */
  public async getBaseTestSuite(
    tests: any[]
  ): Promise<TestSuiteInfo> {
    let rootTestSuite: TestSuiteInfo = {
      type: 'suite',
      id: 'root',
      label: `${this.workspace.name} ${this.testFrameworkName}`,
      children: []
    };

    // Create an array of all test files and then abuse Sets to make it unique.
    let uniqueFiles = [...new Set(tests.map((test: { file_path: string; }) => test.file_path))];
    let groupSubfolders = vscode.workspace.getConfiguration('rubyTestExplorer', null).get('groupSubfolders')
    if(groupSubfolders) {
      this.groupTestsByFolder(rootTestSuite, tests, uniqueFiles)
    } else {
      this.groupTestsByFirstFolder(rootTestSuite, tests, uniqueFiles)
    }

    // Sort all
    this.sortChildren(rootTestSuite);
    return rootTestSuite;
  }

  /** Group tests by first folder in root

    * @param root root TestSuiteInfo
    * @param allTests Array of all tests
    * @param uniqueTestPaths Array of unique test paths
    * @return void
    */
  private groupTestsByFirstFolder(root: TestSuiteInfo, allTests: any[], uniqueTestPaths: string[]): void {
    uniqueTestPaths.forEach(filePath => {

      // Remove the spec/ directory from the file path.
      let relFilePath = filePath.replace(`${this.getTestDirectory()}`, "");

      // Path of file without folder
      const file = relFilePath.indexOf('/') == -1 ? relFilePath : relFilePath.slice(relFilePath.indexOf('/') + 1);
      // first folder of file or undefined (= root)
      const folder =  relFilePath.indexOf('/') == -1 ? undefined : relFilePath.slice(0, relFilePath.indexOf('/'));

      let child = root.children.find((c: any) => c.id === folder) as TestSuiteInfo;
      if (!child && folder) {
        // Create folder if not exists
        child = {
          type: 'suite',
          id: folder,
          label: folder,
          children: [],
          tooltip: folder
        };
        root.children.push(child);
      }

      // If no folder, use root
      if(!folder) {
        child = root;
      }

      // Add file to folder
      let currentFileTestSuite = this.getTestSuiteForFile({ tests: allTests, currentFile: filePath, label: file });
      child.children.push(currentFileTestSuite);
    });
  }

    /** Group tests by all folders

    * @param root root TestSuiteInfo
    * @param allTests Array of all tests
    * @param uniqueTestPaths Array of unique test paths
    * @return void
    */
  private groupTestsByFolder(root: TestSuiteInfo, allTests: any[], uniqueTestPaths: string[]): void {
    uniqueTestPaths.forEach(filePath => {

      // Remove the spec/ directory from the file path.
      let relFilePath = filePath.replace(`${this.getTestDirectory()}`, "");
      let splitted = relFilePath.split("/");

      splitted.reduce((r: any, label: string, i: number, a: Array<string>) => {
        // Create path to current folder/file
        let currentPath = a.slice(0, i + 1).join("/");
        // Add full path to current folder/file
        let fullPath = `${this.getTestDirectory()}${currentPath}`;
        let child = r.children.find((c: any) => c.id === fullPath);

        // Folder already exist, navigate into folder
        if(child) return child;

        // If parts is the file part
        if(a.length - 1 === i) {
          let currentFile = `${this.getTestDirectory()}${currentPath}`;
          let currentFileTestSuite = this.getTestSuiteForFile({ tests: allTests, currentFile: currentFile });
          r.children.push(currentFileTestSuite);
          return;
        } else {
          // Create folder
          let dir = { type: 'suite',
            id: `${this.getTestDirectory()}${currentPath}`,
            label,
            children: [],
            tooltip: currentPath
          };
          r.children.push(dir);
          return dir;
        }
      }, root);
    });
  }

  /**
   * Assigns the process to currentChildProcess and handles its output and what happens when it exits.
   *
   * @param process A process running the tests.
   * @return A promise that resolves when the test run completes.
   */
  handleChildProcess = async (process: childProcess.ChildProcess) => new Promise<string>((resolve, reject) => {
    this.currentChildProcess = process;

    this.currentChildProcess.on('exit', () => {
      this.log.info('Child process has exited. Sending test run finish event.');
      this.currentChildProcess = undefined;
      this.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: 'finished' });
      resolve('{}');
    });

    this.currentChildProcess.stderr!.pipe(split2()).on('data', (data) => {
      data = data.toString();
      this.log.debug(`[CHILD PROCESS OUTPUT] ${data}`);
      if (data.startsWith('Fast Debugger') && this.debugCommandStartedResolver) {
        this.debugCommandStartedResolver()
      }
    });

    this.currentChildProcess.stdout!.pipe(split2()).on('data', (data) => {
      data = data.toString();
      this.log.debug(`[CHILD PROCESS OUTPUT] ${data}`);
      if (data.startsWith('PASSED:')) {
        data = data.replace('PASSED: ', '');
        this.testStatesEmitter.fire(<TestEvent>{ type: 'test', test: data, state: 'passed' });
      } else if (data.startsWith('FAILED:')) {
        data = data.replace('FAILED: ', '');
        this.testStatesEmitter.fire(<TestEvent>{ type: 'test', test: data, state: 'failed' });
      } else if (data.startsWith('RUNNING:')) {
        data = data.replace('RUNNING: ', '');
        this.testStatesEmitter.fire(<TestEvent>{ type: 'test', test: data, state: 'running' });
      } else if (data.startsWith('PENDING:')) {
        data = data.replace('PENDING: ', '');
        this.testStatesEmitter.fire(<TestEvent>{ type: 'test', test: data, state: 'skipped' });
      }
      if (data.includes('START_OF_TEST_JSON')) {
        resolve(data);
      }
    });
  });

  /**
   * Runs the test suite by iterating through each test and running it.
   *
   * @param tests
   * @param debuggerConfig A VS Code debugger configuration.
   */
  runTests = async (tests: string[], debuggerConfig?: vscode.DebugConfiguration): Promise<void> => {
    let testSuite: TestSuiteInfo = await this.tests();
    this.log.debug("-------", tests)
    for (const suiteOrTestId of tests) {
      const node = this.findNode(testSuite, suiteOrTestId);
      if (node) {
        await this.runNode(node, debuggerConfig);
      }
    }
  }

  /**
   * Recursively search for a node in the test suite list.
   *
   * @param searchNode The test or test suite to search in.
   * @param id The id of the test or test suite.
   */
  protected findNode(searchNode: TestSuiteInfo | TestInfo, id: string): TestSuiteInfo | TestInfo | undefined {
    if (searchNode.id === id) {
      return searchNode;
    } else if (searchNode.type === 'suite') {
      for (const child of searchNode.children) {
        const found = this.findNode(child, id);
        if (found) return found;
      }
    }
    return undefined;
  }

  /**
   * Recursively run a node or its children.
   *
   * @param node A test or test suite.
   * @param debuggerConfig A VS Code debugger configuration.
   */
  protected async runNode(node: TestSuiteInfo | TestInfo, debuggerConfig?: vscode.DebugConfiguration): Promise<void> {
    // Special case handling for the root suite, since it can be run
    // with runFullTestSuite()
    if (node.type === 'suite' && node.id === 'root') {
      this.testStatesEmitter.fire(<TestEvent>{ type: 'test', test: node.id, state: 'running' });

      let testOutput = await this.runFullTestSuite(debuggerConfig);
      testOutput = Tests.getJsonFromOutput(testOutput);
      this.log.debug('Parsing the below JSON:');
      this.log.debug(`${testOutput}`);
      let testMetadata = JSON.parse(testOutput);
      let tests: Array<any> = testMetadata.examples;

      if (tests && tests.length > 0) {
        tests.forEach((test: { id: string | TestInfo; }) => {
          this.handleStatus(test);
        });
      }

      this.testStatesEmitter.fire(<TestSuiteEvent>{ type: 'suite', suite: node.id, state: 'completed' });
      // If the suite is a file, run the tests as a file rather than as separate tests.
    } else if (node.type === 'suite' && node.label.endsWith('.rb')) {
      this.testStatesEmitter.fire(<TestSuiteEvent>{ type: 'suite', suite: node.id, state: 'running' });

      let testOutput = await this.runTestFile(`${node.file}`, debuggerConfig);

      testOutput = Tests.getJsonFromOutput(testOutput);
      this.log.debug('Parsing the below JSON:');
      this.log.debug(`${testOutput}`);
      let testMetadata = JSON.parse(testOutput);
      let tests: Array<any> = testMetadata.examples;

      if (tests && tests.length > 0) {
        tests.forEach((test: { id: string | TestInfo; }) => {
          this.handleStatus(test);
        });
      }

      this.testStatesEmitter.fire(<TestSuiteEvent>{ type: 'suite', suite: node.id, state: 'completed' });

    } else if (node.type === 'suite') {

      this.testStatesEmitter.fire(<TestSuiteEvent>{ type: 'suite', suite: node.id, state: 'running' });

      for (const child of node.children) {
        await this.runNode(child, debuggerConfig);
      }

      this.testStatesEmitter.fire(<TestSuiteEvent>{ type: 'suite', suite: node.id, state: 'completed' });

    } else if (node.type === 'test') {
      if (node.file !== undefined && node.line !== undefined) {
        this.testStatesEmitter.fire(<TestEvent>{ type: 'test', test: node.id, state: 'running' });

        // Run the test at the given line, add one since the line is 0-indexed in
        // VS Code and 1-indexed for RSpec/Minitest.
        let testOutput = await this.runSingleTest(`${node.file}:${node.line + 1}`, debuggerConfig);

        testOutput = Tests.getJsonFromOutput(testOutput);
        this.log.debug('Parsing the below JSON:');
        this.log.debug(`${testOutput}`);
        let testMetadata = JSON.parse(testOutput);
        let currentTest = testMetadata.examples[0];

        this.handleStatus(currentTest);
      }
    }
  }

  public async debugCommandStarted(): Promise<string> {
    return new Promise<string>(async (resolve, reject) => {
      this.debugCommandStartedResolver = resolve;
      setTimeout(() => { reject("debugCommandStarted timed out") }, 10000)
    })
  }

  /**
   * Get the absolute path of the custom_formatter.rb file.
   *
   * @return The spec directory
   */
  protected getRubyScriptsLocation(): string {
    return this.context.asAbsolutePath('./ruby');
  }

  /**
   * Runs a single test.
   *
   * @param testLocation A file path with a line number, e.g. `/path/to/test.rb:12`.
   * @param debuggerConfig A VS Code debugger configuration.
   * @return The raw output from running the test.
   */
  abstract runSingleTest: (testLocation: string, debuggerConfig?: vscode.DebugConfiguration) => Promise<string>;

  /**
   * Runs tests in a given file.
   *
   * @param testFile The test file's file path, e.g. `/path/to/test.rb`.
   * @param debuggerConfig A VS Code debugger configuration.
   * @return The raw output from running the tests.
   */
  abstract runTestFile: (testFile: string, debuggerConfig?: vscode.DebugConfiguration) => Promise<string>;

  /**
   * Runs the full test suite for the current workspace.
   *
   * @param debuggerConfig A VS Code debugger configuration.
   * @return The raw output from running the test suite.
   */
  abstract runFullTestSuite: (debuggerConfig?: vscode.DebugConfiguration) => Promise<string>;

  /**
   * Handles test state based on the output returned by the test command.
   *
   * @param test The test that we want to handle.
   */
  abstract handleStatus(test: any): void;
}
