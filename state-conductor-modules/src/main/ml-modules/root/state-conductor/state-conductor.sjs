'use strict';

const TRACE_EVENT = 'state-conductor';

const STATE_CONDUCTOR_JOBS_DB     = 'state-conductor-jobs';
const STATE_CONDUCTOR_TRIGGERS_DB = 'state-conductor-triggers';
const STATE_CONDUCTOR_SCHEMAS_DB  = 'state-conductor-schemas';

const FLOW_FILE_EXTENSION       = '.asl.json';
const FLOW_ITEM_COLLECTION      = 'state-conductor-item';
const FLOW_COLLECTION           = 'state-conductor-flow';
const FLOW_DIRECTORY            = '/state-conductor-flow/';
const FLOW_STATE_PROP_NAME      = 'state-conductor-status';
const FLOW_JOBID_PROP_NAME      = 'state-conductor-job';
const FLOW_PROVENANCE_PROP_NAME = 'state-conductor-status-event';
const FLOW_STATUS_NEW           = 'new';
const FLOW_STATUS_WORKING       = 'working';
const FLOW_STATUS_COMPLETE      = 'complete';
const FLOW_STATUS_FAILED        = 'failed';

const SUPPORTED_STATE_TYPES = [
  'choice',
  'fail', 
  'pass', 
  'succeed', 
  'task'
];

const parseSerializedQuery = (serializedQuery) => {
  return cts.query(fn.head(xdmp.fromJsonString(serializedQuery)));
};

/**
 * Gets a flow definition by flowName
 *
 * @param {*} name
 * @returns
 */
function getFlowDocument(name) {
  name = fn.normalizeSpace(name) + FLOW_FILE_EXTENSION;
  const uri = fn.head(cts.uriMatch('*' + name,
    [
      'document',
      'case-sensitive'
    ],
    cts.collectionQuery(FLOW_COLLECTION)
  ));
  return uri ? cts.doc(uri) : null;
}

function getFlowDocumentFromDatabase(name, databaseId) {
  let resp = xdmp.invokeFunction(() => {
    return getFlowDocument(name);
  }, {
    database: databaseId
  });
  return fn.head(resp);
}

/**
 * Gets all flow definition documents
 *
 * @returns
 */
function getFlowDocuments() {
  return fn.collection(FLOW_COLLECTION);
}

/**
 * Gets all flow definition names
 *
 * @returns
 */
function getFlowNames() {
  return cts.uris('/', ['document'], cts.collectionQuery(FLOW_COLLECTION)).toArray().map(uri => getFlowNameFromUri(uri));
}

/**
 * Given a flow definition URI, determine it's flow name
 *
 * @param {*} uri
 * @returns
 */
function getFlowNameFromUri(uri) {
  uri = uri.toString(); 
  uri = uri.slice(uri.lastIndexOf('/') + 1);
  return uri.lastIndexOf(FLOW_FILE_EXTENSION) !== -1 ? uri.slice(0, uri.lastIndexOf(FLOW_FILE_EXTENSION)) : uri;
}

/**
 * Returns the initial state for the given state machine definition
 *
 * @param {*} { flowName, StartAt }
 * @returns
 */
function getInitialState({ flowName, StartAt }) {
  if (!StartAt || StartAt.length === 0) {
    fn.error(null, 'INVALID-STATE-DEFINITION', `no "StartAt" defined for state machine "${flowName}"`);
  }
  return StartAt;
}

/**
 * Gets the flow-conductor-status property for the given flowName
 *
 * @param {*} uri
 * @param {*} flowName
 * @returns
 */
function getFlowStatusProperty(uri, flowName) {
  if (fn.docAvailable(uri)) {
    return xdmp.documentGetProperties(uri, fn.QName('', FLOW_STATE_PROP_NAME))
      .toArray()
      .filter(prop => prop.getAttributeNode('flow-name').nodeValue === flowName)[0];
  }
}

function getJobMetadatProperty(uri, flowName) {
  if (fn.docAvailable(uri)) {
    return xdmp.documentGetProperties(uri, fn.QName('', FLOW_JOBID_PROP_NAME))
      .toArray()
      .filter(prop => prop.getAttributeNode('flow-name').nodeValue === flowName);
  }
}

/**
 * Determines if this job document is being processed by any state conductor flow
 * <state-conductor-status flow="flow-name" state="state-name">flow-status</state-conductor-status>
 * @param {*} uri
 * @returns
 */
function isJobInProcess(uri) {
  return cts.contains(
    xdmp.documentProperties(uri), 
    cts.elementValueQuery(fn.QName('', FLOW_STATE_PROP_NAME), FLOW_STATUS_WORKING)
  );
}


/**
 * Gets the flowName for each flow currently processing this document
 *
 * @param {*} uri
 * @returns
 */
function getInProcessFlows(uri) {
  if (fn.docAvailable(uri)) {
    return xdmp.documentGetProperties(uri, fn.QName('', FLOW_STATE_PROP_NAME))
      .toArray()
      .filter(prop => prop.firstChild.nodeValue === FLOW_STATUS_WORKING)
      .map(prop => prop.getAttributeNode('flow-name').nodeValue);
  }
}

/**
 * Sets this document's flow status for the given flow
 *
 * @param {*} uri
 * @param {*} flowName
 * @param {*} stateName
 * @param {*} status
 */
function setFlowStatus(uri, flowName, stateName, status = FLOW_STATUS_WORKING) {
  declareUpdate();
  const existingStatusProp = getFlowStatusProperty(uri, flowName);
  const builder = new NodeBuilder();
  builder.startElement(FLOW_STATE_PROP_NAME);
  builder.addAttribute('flow-name', flowName);
  builder.addAttribute('state-name', stateName);
  builder.addText(status);
  builder.endElement();
  let statusElem = builder.toNode();
  
  if (existingStatusProp) {
    // replace the exsting property
    xdmp.nodeReplace(existingStatusProp, statusElem);
  } else {
    // insert the new property
    xdmp.documentAddProperties(uri, [statusElem]);
  }
}

function addJobMetadata(uri, flowName, jobId) {
  const builder = new NodeBuilder();
  builder.startElement(FLOW_JOBID_PROP_NAME);
  builder.addAttribute('flow-name', flowName);
  builder.addAttribute('job-id', jobId);
  builder.addAttribute('date', (new Date()).toISOString());
  builder.endElement();
  let jobMetaElem = builder.toNode();
  xdmp.documentAddProperties(uri, [jobMetaElem]);
}

function addProvenanceEvent(uri, flowName, currState = '', nextState = '') {
  const builder = new NodeBuilder();
  builder.startElement(FLOW_PROVENANCE_PROP_NAME);
  builder.addAttribute('date', (new Date()).toISOString());
  builder.addAttribute('flow-name', flowName);
  builder.addAttribute('from', currState);
  builder.addAttribute('to', nextState);
  builder.endElement();
  let newEvent = builder.toNode();
  xdmp.documentAddProperties(uri, [newEvent]);
}

/**
 * Gets the document's state in the given flow
 *
 * @param {*} uri
 * @param {*} flowName
 * @returns
 */
function getFlowState(uri, flowName) {
  const statusProp = getFlowStatusProperty(uri, flowName);
  return statusProp ? statusProp.getAttributeNode('state-name').nodeValue : null;
}

/**
 * Gets the document's status in the given flow
 *
 * @param {*} uri
 * @param {*} flowName
 * @returns
 */
function getFlowStatus(uri, flowName) {
  const statusProp = getFlowStatusProperty(uri, flowName);
  return statusProp ? statusProp.firstChild.nodeValue : null;
}

function getJobIds(uri, flowName) {
  const jobProps = getJobMetadatProperty(uri, flowName);
  return jobProps.map(prop => prop.getAttributeNode('job-id').nodeValue);
}

/**
 * Determines if the given document matches the given flow's context
 *
 * @param {*} uri
 * @param {*} flow
 * @returns
 */
function checkFlowContext(uri, flow) {
  if (fn.docAvailable(uri)) {
    const query = getFlowContextQuery(flow);
    const uris = cts.uris('', 'limit=1', cts.andQuery([
      cts.documentQuery(uri),
      query
    ]));
    return uri === fn.string(fn.head(uris));
  }

  return false;
}

/**
 * Given a document's uri, finds all the flows whose context applies,
 * and which have not previously processed this document.
 *
 * @param {*} uri
 * @returns
 */
function getApplicableFlows(uri) {
  const flows = getFlowDocuments().toArray().filter(flow => {
    let flowName = getFlowNameFromUri(fn.documentUri(flow));
    let flowOjb = flow.toObject();
    return getJobIds(uri, flowName).length === 0 && !getFlowStatus(uri, flowName) && checkFlowContext(uri, flowOjb);
  });

  return flows;
}


/**
 * Given a flow, generate a cts query for it's context
 *
 * @param {*} flow
 * @returns
 */
function getFlowContextQuery(flow) {
  const domain = flow.mlDomain;
  const context = domain.context || [];
  let queries = context.map(ctx => {
    if (ctx.scope === 'collection') {
      return cts.collectionQuery(ctx.value);
    } else if (ctx.scope === 'directory') {
      return cts.directoryQuery(ctx.value, 'infinity');
    } else if (ctx.scope === 'query') {
      return parseSerializedQuery(ctx.value);
    }
    return cts.falseQuery();
  });

  if (queries.length > 1) {
    queries = cts.orQuery(queries);
  } else if (queries.length < 1) {
    queries = cts.falseQuery();
  } else {
    queries = queries.pop();
  }

  return queries;
}


/**
 * Generate a cts query matching the context of all flows
 *
 * @returns
 */
function getAllFlowsContextQuery() {
  let queries = getFlowDocuments().toArray().map(flow => getFlowContextQuery(flow.toObject()));

  if (queries.length === 0) {
    queries = cts.falseQuery();
  } else if (queries.length === 1) {
    queries = queries.pop();
  } else {
    queries = cts.orQuery(queries);
  }

  return queries;
}

function executeState(uri, flowName, stateName) {
  const jobDoc = cts.doc(uri);
  const jobObj = jobDoc.toObject();
  const flowObj = getFlowDocumentFromDatabase(flowName, jobObj.database).toObject();
  const state = flowObj.States[stateName];

  try {
    if (state) {
      // perform the actions for the "Task" state
      if (state.Type && state.Type.toLowerCase() === 'task') {
        xdmp.trace(TRACE_EVENT, `executing action for state: ${stateName}`);
  
        if (state.Resource) {
          // execute the resource modules
          let resp = executeActionModule(
            state.Resource, 
            jobObj.uri, 
            state.Parameters, 
            jobObj.context, 
            {
              database: jobObj.database,
              modules: jobObj.modules
            });
          // update the job context with the response
          jobObj.context[stateName] = resp;
        } else {
          fn.error(null, 'INVALID-STATE-DEFINITION', `no "Resource" defined for Task state "${stateName}"`);
        }
      }

      // determine the next target state and transition
      let targetState = null;
      xdmp.trace(TRACE_EVENT, `executing transitions for state: ${stateName}`);

      if (!inTerminalState(uri, flowName, flowObj)) {    
        if ('task' === state.Type.toLowerCase()) {
          targetState = state.Next;
        } else if ('pass' === state.Type.toLowerCase()) {
          targetState = state.Next;
        } else if ('choice' === state.Type.toLowerCase()) {
          if (state.Choices && state.Choices.length > 0) {
            state.Choices.forEach(choice => {
              if (!targetState) {
                if (choice.Resource) {
                  let resp = fn.head(
                    executeConditionModule(
                      choice.Resource, 
                      jobObj.uri, 
                      choice.Parameters, 
                      jobObj.context, 
                      {
                        database: jobObj.database,
                        modules: jobObj.modules
                      }
                    )
                  );
                  targetState = resp ? choice.Next : null;
                } else {
                  fn.error(null, 'INVALID-STATE-DEFINITION', `Choices defined without "Resource" in state "${stateName}"`);  
                }
              }
            });
            targetState = targetState || state.Default;
          } else {
            fn.error(null, 'INVALID-STATE-DEFINITION', `no "Choices" defined for Choice state "${stateName}"`);  
          }
        } else {
          fn.error(null, 'INVALID-STATE-DEFINITION', `unsupported transition from state type "${stateName.Type}"`);
        }

        // perform the transition
        if (targetState) {
          setFlowStatus(uri, flowName, targetState);
          addProvenanceEvent(uri, flowName, stateName, targetState);
          jobObj.flowStatus = FLOW_STATUS_WORKING;
          jobObj.flowState = targetState;
          jobObj.provenance.push({
            date: (new Date()).toISOString(),
            from: stateName,
            to: targetState
          });
        } else {
          fn.error(null, 'INVALID-STATE-DEFINITION', `No suitable transition found in non-terminal state "${stateName}"`);
        }
      } else {
        // terminal states have no "Next" target state
        setFlowStatus(uri, flowName, stateName, FLOW_STATUS_COMPLETE);
        addProvenanceEvent(uri, flowName, stateName, 'COMPLETED');
        jobObj.flowStatus = FLOW_STATUS_COMPLETE;
        jobObj.provenance.push({
          date: (new Date()).toISOString(),
          from: stateName,
          to: 'COMPLETED'
        });
      }

      // update the state status and provenence in the job doc
      xdmp.nodeReplace(jobDoc.root, jobObj);

    } else {
      fn.error(null, 'state not found', Sequence.from([`state "${stateName}" not found in flow`]));
    }
  } catch (err) {
    handleStateFailure(uri, flowName, flowObj, stateName, err);
  }
}

function executeActionModule(modulePath, uri, params, context, { database, modules }) {
  let resp = xdmp.invokeFunction(() => {
    const actionModule = require(modulePath);
    if (typeof actionModule.performAction === 'function') {
      return actionModule.performAction(uri, params, context);
    } else {
      fn.error(null, 'INVALID-STATE-DEFINITION', `no "performAction" function defined for action module "${modulePath}"`);
    }
  }, {
    database: database ? database : xdmp.database(),
    modules: modules ? modules : xdmp.modulesDatabase()
  });
  return fn.head(resp);
}

function executeConditionModule(modulePath, uri, params, context, { database, modules }) {
  let resp = xdmp.invokeFunction(() => {
    const conditionModule = require(modulePath);
    if (typeof conditionModule.checkCondition === 'function') {
      return conditionModule.checkCondition(uri, params, context);
    } else {
      fn.error(null, 'INVALID-STATE-DEFINITION', `no "checkCondition" function defined for condition module "${modulePath}"`);
    }
  }, {
    database: database ? database : xdmp.database(),
    modules: modules ? modules : xdmp.modulesDatabase()
  });
  return fn.head(resp);
}

/**
 * Processes a caught error for "Task" and "Choice" states
 * Uses "Choices" to transition to a failure state
 *
 * @param {*} uri
 * @param {*} flowName
 * @param {*} flow
 * @param {*} stateName
 * @param {*} err
 * @returns
 */
function handleStateFailure(uri, flowName, flow, stateName, err) {
  const currState = flow.States[stateName];
  xdmp.trace(TRACE_EVENT, `handling state failures for state: ${stateName}`);
  xdmp.trace(TRACE_EVENT, Sequence.from([err]));
  const jobDoc = cts.doc(uri);
  const jobObj = jobDoc.toObject();

  if (currState && (
    'task' === currState.Type.toLowerCase() || 
    'choice' === currState.Type.toLowerCase())) {
    if (currState.Catch && currState.Catch.length > 0) {
      // find a matching fallback state
      let target = currState.Catch.reduce((acc, fallback) => {
        if (!acc) {
          if (
            fallback.ErrorEquals.includes(err.name) ||
            fallback.ErrorEquals.includes('States.ALL') ||
            fallback.ErrorEquals.includes('*')
          ) {
            acc = fallback.Next;
          }
        }
        return acc;
      }, null);
      
      if (target) {
        xdmp.trace(TRACE_EVENT, `transitioning to fallback state "${target}"`);
        // move to the target state
        setFlowStatus(uri, flowName, target);
        addProvenanceEvent(uri, flowName, stateName, target);
        // capture error message in context
        jobObj.flowStatus = FLOW_STATUS_WORKING;
        jobObj.flowState = target;
        jobObj.provenance.push({
          date: (new Date()).toISOString(),
          from: stateName,
          to: target
        });
        jobObj.errors = jobObj.errors || {};
        jobObj.errors[stateName] = err;
        xdmp.nodeReplace(jobDoc.root, jobObj);
        return;
      }
    }
  }
  // unhandled exception
  xdmp.trace(TRACE_EVENT, `no Catch defined for error "${err.name}" in state "${stateName}"`);
  // update the job document
  setFlowStatus(uri, flowName, stateName, FLOW_STATUS_FAILED);
  jobObj.flowStatus = FLOW_STATUS_FAILED;
  jobObj.errors = jobObj.errors || {};
  jobObj.errors[stateName] = err;
  xdmp.nodeReplace(jobDoc.root, jobObj);
  // trigger CPF error state
  fn.error(null, 'INVALID-STATE-DEFINITION', Sequence.from([
    `Unhandled exception of type "${err.name}" in state "${stateName}"`,
    err
  ]));
}

/**
 * Determines if the given document is in terminal (final) state for the given flow
 *
 * @param {*} uri
 * @param {*} flow
 * @returns
 */
function inTerminalState(uri, flowName, flow) {
  const currStateName = getFlowState(uri, flowName);
  let currState = flow.States[currStateName];
  
  if (currState && !SUPPORTED_STATE_TYPES.includes(currState.Type.toLowerCase())) {
    fn.error(null, 'INVALID-STATE-DEFINITION', `unsupported state type: "${currState.Type}"`);
  }
  //return !currState || !currState.transitions || currState.transitions.length === 0;
  return (
    !currState || 
    currState.Type.toLowerCase() === 'succeed' ||
    currState.Type.toLowerCase() === 'fail' ||
    (currState.Type.toLowerCase() === 'task' && currState.End === true)
  );
}

/**
 * Calculates the state of documents being processed by, and completed through this flow
 *
 * @param {*} flowName
 * @returns
 */
function getFlowCounts(flowName, { startDate, endDate }) {
  const flow = getFlowDocument(flowName).toObject();
  const states = Object.keys(flow.States);

  let baseQuery = [];
  if (startDate) {
    baseQuery.push(cts.jsonPropertyRangeQuery('createdDate', '>=', xs.dateTime(startDate)));
  }
  if (endDate) {
    baseQuery.push(cts.jsonPropertyRangeQuery('createdDate', '<=', xs.dateTime(endDate)))
  }

  const numInStatus = (status) => fn.count(
    cts.uris('', null, 
      cts.andQuery([].concat(
        baseQuery,
        cts.propertiesFragmentQuery(
          cts.elementQuery(fn.QName('', FLOW_STATE_PROP_NAME), cts.andQuery([
            cts.elementAttributeValueQuery(fn.QName('', FLOW_STATE_PROP_NAME), fn.QName('', 'flow-name'), flowName),
            cts.elementValueQuery(fn.QName('', FLOW_STATE_PROP_NAME), status)
          ]))
        )
      ))      
    )
  );

  const numInState = (status, state) => fn.count(
    cts.uris('', null,
      cts.andQuery([].concat(
        baseQuery,
        cts.propertiesFragmentQuery(
          cts.elementQuery(fn.QName('', FLOW_STATE_PROP_NAME), cts.andQuery([
            cts.elementAttributeValueQuery(fn.QName('', FLOW_STATE_PROP_NAME), fn.QName('', 'flow-name'), flowName),
            cts.elementAttributeValueQuery(fn.QName('', FLOW_STATE_PROP_NAME), fn.QName('', 'state-name'), state),
            cts.elementValueQuery(fn.QName('', FLOW_STATE_PROP_NAME), status)
          ]))
        )
      ))
    )
  );

  let numComplete = 0;
  let numWorking  = 0;
  let numNew      = 0;
  let numFailed   = 0;

  const resp = {
    flowName: flowName,
    totalComplete: numComplete,
    totalWorking: numWorking,
    totalFailed: numFailed,
    totalNew: numNew
  };

  xdmp.invokeFunction(() => {
    resp.totalComplete = numInStatus(FLOW_STATUS_COMPLETE);
    resp.totalWorking  = numInStatus(FLOW_STATUS_WORKING);
    resp.totalNew      = numInStatus(FLOW_STATUS_NEW);
    resp.totalFailed   = numInStatus(FLOW_STATUS_FAILED);

    [FLOW_STATUS_WORKING, FLOW_STATUS_COMPLETE].forEach(status => {
      resp[status] = {};
      states.forEach(state => {
        resp[status][state] = numInState(status, state);
      });
    });
  }, {
    database: xdmp.database(STATE_CONDUCTOR_JOBS_DB)
  });  

  return resp;
}

// checks if its a temporal document and if its latested document
function isLatestTemporalDocument(uri){
  const temporal = require('/MarkLogic/temporal.xqy');
  const temporalCollections = temporal.collections().toArray();
  const documentCollections = xdmp.documentGetCollections(uri);

  const hasTemporalCollection = temporalCollections.some(collection => {
    //the temporalCollections are not strings so we need to convert them into strings
    return documentCollections.includes(collection.toString());
  });
  
  return ((hasTemporalCollection.length > 0) && documentCollections.includes('latest'));
}


/**
 * Convienence function to create a job record for a document to be
 * processed by a state conductor flow.
 *
 * @param {*} flowName
 * @param {*} uri
 * @param {*} [context={}]
 * @param {*} [options={}]
 */
function createStateConductorJob(flowName, uri, context = {}, options = {}) {
  const collections = ['stateConductorJob'].concat(options.collections || []);
  const directory = options.directory || '/stateConductorJob/';
  const database = options.database || xdmp.database();
  const modules = options.modules || xdmp.modulesDatabase();
  
  const id = sem.uuidString();
  const jobUri = directory + id + '.json';

  const job = {
    id: id,
    flowName: flowName,
    flowStatus: FLOW_STATUS_NEW,
    flowState: null,
    uri: uri,
    database: database,
    modules: modules,
    createdDate: (new Date()).toISOString(),
    context: context,
    provenance: []
  };

  // insert the job document
  xdmp.trace(TRACE_EVENT, `inserting job document: ${jobUri} into db ${STATE_CONDUCTOR_JOBS_DB}`);
  xdmp.invokeFunction(() => {
    declareUpdate();
    xdmp.documentInsert(jobUri, job, {
      collections: collections,
      permissions: xdmp.defaultPermissions()
    });
  }, {
    database: xdmp.database(STATE_CONDUCTOR_JOBS_DB)
  });
  
  // add job metadata to the target document
  addJobMetadata(uri, flowName, id); // prevents updates to the target from retriggering this flow

  return id;
}

/**
 * Convienence function to create job records for a batch of documents to be
 * processed by a state conductor flow.
 *
 * @param {*} flowName
 * @param {*} [uris=[]]
 * @param {*} [context={}]
 * @param {*} [options={}]
 * @returns
 */
function batchCreateStateConductorJob(flowName, uris = [], context = {}, options = {}) {
  const ids = uris.map(uri => createStateConductorJob(flowName, uri, context, options));
  return ids;
}

module.exports = {
  TRACE_EVENT,
  STATE_CONDUCTOR_JOBS_DB,
  STATE_CONDUCTOR_TRIGGERS_DB,
  STATE_CONDUCTOR_SCHEMAS_DB,
  FLOW_COLLECTION,
  FLOW_DIRECTORY,
  FLOW_ITEM_COLLECTION,
  addJobMetadata,
  addProvenanceEvent,
  batchCreateStateConductorJob,
  checkFlowContext,
  createStateConductorJob,
  executeState,
  getAllFlowsContextQuery,
  getApplicableFlows,
  getFlowContextQuery,
  getFlowCounts,
  getFlowDocument,
  getFlowDocumentFromDatabase,
  getFlowDocuments,
  getFlowNames,
  getFlowNameFromUri,
  getFlowState,
  getFlowStatus,
  getInitialState,
  getInProcessFlows,
  getJobIds,
  handleStateFailure,
  inTerminalState,
  isJobInProcess,
  setFlowStatus
};