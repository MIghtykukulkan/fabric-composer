/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const config = require('../config/environment');
const BusinessNetworkDefinition = require('composer-common').BusinessNetworkDefinition;
const Logger = require('composer-common').Logger;
const realSerializerr = require('serializerr');
const uuid = require('uuid');
const exec = require('child_process').exec;
const request = require('request');

const LOG = Logger.getLog('ConnectorServer');

/**
 * A wrapper around serializerr that checks for non-error objects
 * like strings that are sometimes incorrectly returned by hfc.
 * @param {Error} error The error to serialize with serializerr.
 * @return {Object} The error serialized by serializerr.
 */
function serializerr (error) {
    if (error instanceof Error) {
        return realSerializerr(error);
    } else {
        return realSerializerr(new Error(error.toString()));
    }
}

/**
 * A connector server for hosting Composer connectors and
 * serving them over a connected socket.io socket.
 */
class ConnectorServer {

    /**
     * Constructor.
     * @param {ConnectionProfileStore} connectionProfileStore The connection profile store to use.
     * @param {ConnectionProfileManager} connectionProfileManager The connection profile manager to use.
     * @param {Socket} socket The connected socket to use for communicating with the client.
     */
    constructor (connectionProfileStore, connectionProfileManager, socket) {
        const method = 'constructor';
        LOG.entry(method, connectionProfileStore, connectionProfileManager, socket);
        this.connectionProfileStore = connectionProfileStore;
        this.connectionProfileManager = connectionProfileManager;
        this.socket = socket;
        let propertyNames = Object.getOwnPropertyNames(Object.getPrototypeOf(this));
        propertyNames.forEach((propertyName) => {
            if (propertyName === 'constructor') {
                return;
            }
            let property = this[propertyName];
            if (typeof property === 'function') {
                this.socket.on(`/api/${propertyName}`, this[propertyName].bind(this));
            }
        });
        this.connections = {};
        this.securityContexts = {};
        LOG.exit(method);
    }

    /**
     * Handle a request from the client to connect to a business network.
     * @param {string} connectionProfile The connection profile name.
     * @param {string} businessNetworkIdentifier The business network identifier.
     * @param {Object} connectionOptions The connection profile options to use.
     * @param {function} callback The callback to call when complete.
     * @return {Promise} A promise that is resolved when complete.
     */
    connectionManagerConnect (connectionProfile, businessNetworkIdentifier, connectionOptions, callback) {
        const method = 'connectionManagerConnect';
        LOG.entry(method, connectionProfile, businessNetworkIdentifier, connectionOptions);
        return this.connectionProfileStore.load(connectionProfile, connectionOptions)
            .then((existingConnectionOptions) => {
                connectionOptions = Object.assign({}, existingConnectionOptions, connectionOptions);
            })
            .catch((error) => {
                // Ignore, it doesn't exist.
            })
            .then(() => {
                return this.connectionProfileStore.save(connectionProfile, connectionOptions);
            })
            .then(() => {
                return this.connectionProfileManager.connect(connectionProfile, businessNetworkIdentifier);
            })
            .then((connection) => {
                let connectionID = uuid.v4();
                this.connections[connectionID] = connection;
                callback(null, connectionID);
                LOG.exit(method, connectionID);
            })
            .catch((error) => {
                LOG.error(error);
                callback(serializerr(error));
                LOG.exit(method, null);
            });
    }

    /**
     * Handle a request from the client to disconnect from a business network.
     * @param {string} connectionID The connection ID.
     * @param {function} callback The callback to call when complete.
     * @return {Promise} A promise that is resolved when complete.
     */
    connectionDisconnect (connectionID, callback) {
        const method = 'connectionDisconnect';
        LOG.entry(method, connectionID);
        let connection = this.connections[connectionID];
        if (!connection) {
            let error = new Error(`No connection found with ID ${connectionID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        return connection.disconnect()
            .then(() => {
                callback(null);
                LOG.exit(method);
            })
            .catch((error) => {
                LOG.error(error);
                callback(serializerr(error));
                LOG.exit(method);
            });
    }

    /**
     * Handle a request from the client to login to a business network.
     * @param {string} connectionID The connection ID.
     * @param {string} enrollmentID The enrollment ID.
     * @param {string} enrollmentSecret The enrollment secret.
     * @param {function} callback The callback to call when complete.
     * @return {Promise} A promise that is resolved when complete.
     */
    connectionLogin (connectionID, enrollmentID, enrollmentSecret, callback) {
        const method = 'connectionLogin';
        LOG.entry(method, connectionID, enrollmentID, enrollmentSecret);
        let connection = this.connections[connectionID];
        if (!connection) {
            let error = new Error(`No connection found with ID ${connectionID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        return connection.login(enrollmentID, enrollmentSecret)
            .then((securityContext) => {
                let securityContextID = uuid.v4();
                this.securityContexts[securityContextID] = securityContext;
                callback(null, securityContextID);
                LOG.exit(method, securityContextID);
            })
            .catch((error) => {
                LOG.error(error);
                callback(serializerr(error));
                LOG.exit(method);
            });
    }

    /**
     * Handle a request from the client to deploy a business network.
     * @param {string} connectionID The connection ID.
     * @param {string} securityContextID The security context ID.
     * @param {boolean} force Deploy a new instance if the business network is already deployed.
     * @param {string} businessNetworkBase64 The business network archive, as a base64 encoded string.
     * @param {function} callback The callback to call when complete.
     * @return {Promise} A promise that is resolved when complete.
     */
    connectionDeploy (connectionID, securityContextID, force, businessNetworkBase64, callback) {
        const method = 'connectionDeploy';
        LOG.entry(method, connectionID, securityContextID, force, businessNetworkBase64);
        let connection = this.connections[connectionID];
        if (!connection) {
            let error = new Error(`No connection found with ID ${connectionID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        let securityContext = this.securityContexts[securityContextID];
        if (!securityContext) {
            let error = new Error(`No security context found with ID ${securityContextID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        let businessNetworkArchive = Buffer.from(businessNetworkBase64, 'base64');
        return BusinessNetworkDefinition.fromArchive(businessNetworkArchive)
            .then((businessNetworkDefinition) => {
                return connection.deploy(securityContext, force, businessNetworkDefinition);
            })
            .then(() => {
                callback(null);
                LOG.exit(method);
            })
            .catch((error) => {
                LOG.error(error);
                callback(serializerr(error));
                LOG.exit(method);
            });
    }

    /**
     * Handle a request from the client to update a deployed business network.
     * @param {string} connectionID The connection ID.
     * @param {string} securityContextID The security context ID.
     * @param {string} businessNetworkBase64 The business network archive, as a base64 encoded string.
     * @param {function} callback The callback to call when complete.
     * @return {Promise} A promise that is resolved when complete.
     */
    connectionUpdate (connectionID, securityContextID, businessNetworkBase64, callback) {
        const method = 'connectionUpdate';
        LOG.entry(method, connectionID, securityContextID, businessNetworkBase64);
        let connection = this.connections[connectionID];
        if (!connection) {
            let error = new Error(`No connection found with ID ${connectionID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        let securityContext = this.securityContexts[securityContextID];
        if (!securityContext) {
            let error = new Error(`No security context found with ID ${securityContextID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        let businessNetworkArchive = Buffer.from(businessNetworkBase64, 'base64');
        return BusinessNetworkDefinition.fromArchive(businessNetworkArchive)
            .then((businessNetworkDefinition) => {
                return connection.update(securityContext, businessNetworkDefinition);
            })
            .then(() => {
                callback(null);
                LOG.exit(method);
            })
            .catch((error) => {
                LOG.error(error);
                callback(serializerr(error));
                LOG.exit(method);
            });
    }

    /**
     * Handle a request from the client to undeploy a deployed business network.
     * @param {string} connectionID The connection ID.
     * @param {string} securityContextID The security context ID.
     * @param {string} businessNetworkIdentifier The business network identifier.
     * @param {function} callback The callback to call when complete.
     * @return {Promise} A promise that is resolved when complete.
     */
    connectionUndeploy (connectionID, securityContextID, businessNetworkIdentifier, callback) {
        const method = 'connectionUndeploy';
        LOG.entry(method, connectionID, securityContextID, businessNetworkIdentifier);
        let connection = this.connections[connectionID];
        if (!connection) {
            let error = new Error(`No connection found with ID ${connectionID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        let securityContext = this.securityContexts[securityContextID];
        if (!securityContext) {
            let error = new Error(`No security context found with ID ${securityContextID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        return connection.undeploy(securityContext, businessNetworkIdentifier)
            .then(() => {
                callback(null);
                LOG.exit(method);
            })
            .catch((error) => {
                LOG.error(error);
                callback(serializerr(error));
                LOG.exit(method);
            });
    }

    /**
     * Handle a request from the client to test the connection to the business network.
     * @param {string} connectionID The connection ID.
     * @param {string} securityContextID The security context ID.
     * @param {function} callback The callback to call when complete.
     * @return {Promise} A promise that is resolved when complete.
     */
    connectionPing (connectionID, securityContextID, callback) {
        const method = 'connectionPing';
        LOG.entry(method, connectionID, securityContextID);
        let connection = this.connections[connectionID];
        if (!connection) {
            let error = new Error(`No connection found with ID ${connectionID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        let securityContext = this.securityContexts[securityContextID];
        if (!securityContext) {
            let error = new Error(`No security context found with ID ${securityContextID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        return connection.ping(securityContext)
            .then((result) => {
                callback(null, result);
                LOG.exit(method, result);
            })
            .catch((error) => {
                LOG.error(error);
                callback(serializerr(error));
                LOG.exit(method);
            });
    }

    /**
     * Handle a request from the client to issue a query request to the business network.
     * @param {string} connectionID The connection ID.
     * @param {string} securityContextID The security context ID.
     * @param {string} functionName The runtime function to call.
     * @param {string[]} args The arguments to pass to the runtime function.
     * @param {function} callback The callback to call when complete.
     * @return {Promise} A promise that is resolved when complete.
     */
    connectionQueryChainCode (connectionID, securityContextID, functionName, args, callback) {
        const method = 'connectionQueryChainCode';
        LOG.entry(method, connectionID, securityContextID, functionName, args);
        let connection = this.connections[connectionID];
        if (!connection) {
            let error = new Error(`No connection found with ID ${connectionID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        let securityContext = this.securityContexts[securityContextID];
        if (!securityContext) {
            let error = new Error(`No security context found with ID ${securityContextID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        return connection.queryChainCode(securityContext, functionName, args)
            .then((result) => {
                callback(null, result.toString());
                LOG.exit(method, result.toString());
            })
            .catch((error) => {
                LOG.error(error);
                callback(serializerr(error));
                LOG.exit(method, null);
            });
    }

    /**
     * Handle a request from the client to issue an invoke request to the business network.
     * @param {string} connectionID The connection ID.
     * @param {string} securityContextID The security context ID.
     * @param {string} functionName The runtime function to call.
     * @param {string[]} args The arguments to pass to the runtime function.
     * @param {function} callback The callback to call when complete.
     * @return {Promise} A promise that is resolved when complete.
     */
    connectionInvokeChainCode (connectionID, securityContextID, functionName, args, callback) {
        const method = 'connectionInvokeChainCode';
        LOG.entry(method, connectionID, securityContextID, functionName, args);
        let connection = this.connections[connectionID];
        if (!connection) {
            let error = new Error(`No connection found with ID ${connectionID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        let securityContext = this.securityContexts[securityContextID];
        if (!securityContext) {
            let error = new Error(`No security context found with ID ${securityContextID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        return connection.invokeChainCode(securityContext, functionName, args)
            .then(() => {
                callback(null);
                LOG.exit(method);
            })
            .catch((error) => {
                LOG.error(error);
                callback(serializerr(error));
                LOG.exit(method);
            });
    }

    /**
     * Handle a request from the client to create an identity for a participant in the business network.
     * @param {string} connectionID The connection ID.
     * @param {string} securityContextID The security context ID.
     * @param {string} userID The user ID of the new identity.
     * @param {Object} options The options to use to create the new identity.
     * @param {function} callback The callback to call when complete.
     * @return {Promise} A promise that is resolved when complete.
     */
    connectionCreateIdentity (connectionID, securityContextID, userID, options, callback) {
        const method = 'connectionCreateIdentity';
        LOG.entry(method, connectionID, securityContextID, userID, options);
        let connection = this.connections[connectionID];
        if (!connection) {
            let error = new Error(`No connection found with ID ${connectionID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        let securityContext = this.securityContexts[securityContextID];
        if (!securityContext) {
            let error = new Error(`No security context found with ID ${securityContextID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        return connection.createIdentity(securityContext, userID, options)
            .then((result) => {
                callback(null, result);
                LOG.exit(method, result);
            })
            .catch((error) => {
                LOG.error(error);
                callback(serializerr(error));
                LOG.exit(method, null);
            });
    }

    /**
     * Handle a request from the client to list all deployed business networks.
     * @param {string} connectionID The connection ID.
     * @param {string} securityContextID The security context ID.
     * @param {function} callback The callback to call when complete.
     * @return {Promise} A promise that is resolved when complete.
     */
    connectionList (connectionID, securityContextID, callback) {
        const method = 'connectionList';
        LOG.entry(method, connectionID, securityContextID);
        let connection = this.connections[connectionID];
        if (!connection) {
            let error = new Error(`No connection found with ID ${connectionID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        let securityContext = this.securityContexts[securityContextID];
        if (!securityContext) {
            let error = new Error(`No security context found with ID ${securityContextID}`);
            LOG.error(error);
            callback(serializerr(error));
            LOG.exit(method, null);
            return;
        }
        return connection.list(securityContext)
            .then((result) => {
                callback(null, result);
                LOG.exit(method, result);
            })
            .catch((error) => {
                LOG.error(error);
                callback(serializerr(error));
                LOG.exit(method, null);
            });
    }

    /**
     * Check if environment has client id and secret in
     * @param {function} callback The callback to call when complete
     * @return {Promise} A promise that is resolved when complete.
     */
    isOAuthEnabled(callback) {
        if(config.clientId && config.clientSecret) {
            return callback(null, true);
        }

        return callback(null, false);
    }

    /**
     * Run npm view to get the details of a npm module
     * @param {string} moduleName The name of the module
     * @param {function} callback The callback to call when complete
     * @return {Promise} A promise that is resolved when complete.
     */
    getNpmInfo (moduleName, callback) {
        const method = 'getNpmInfo';
        LOG.entry(method, moduleName);
        let child = exec('npm view ' + moduleName,
            function (error, stdout, stderr) {
                if (error !== null) {
                    LOG.error(error);
                    LOG.exit(method, null);
                    return callback(error);
                } else {
                    try {
                        let output = stdout.replace(/\n/g, '');
                        let sortOfParsed = JSON.stringify(eval('(' + output + ')'));
                        let result = JSON.parse(sortOfParsed);
                        LOG.exit(method, result);
                        return callback(null, result);
                    } catch (error) {
                        LOG.error(error);
                        return callback(error);
                    }
                }
            });

        LOG.exit(method, null);
        return child;
    }

    /**
     * Exchange access code for a access token from github
     * @param {string} accessCode The code obtained from authenicating with github
     * @param {function} callback The callback to call when complete
     * @return {Promise} A promise that is resolved when complete.
     */
    getGitHubAccessToken (accessCode, callback) {
        const method = 'getGithubAccessToken';
        LOG.entry(method, accessCode);

        let endpoint = config.githubAccessTokenUrl + '?' +
            'client_id=' + config.clientId +
            '&client_secret=' + config.clientSecret +
            '&code=' + accessCode;

        return request({
            method : 'POST',
            url : endpoint,
            json : true
        }, function handleResponse (err, response) {
            if (err) {
                LOG.error({err : err}, 'Error occurred while attempting to exchange code for access token.');
                return callback(err);
            }

            return callback(null, response.body);
        });
    }
}

module.exports = ConnectorServer;
