/**
 * Copyright (c) 2002-2017 "Neo Technology,","
 * Network Engine for Objects in Lund AB [http://neotechnology.com]
 *
 * This file is part of Neo4j.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Session from './session';
import Pool from './internal/pool';
import {connect} from './internal/connector';
import StreamObserver from './internal/stream-observer';
import {newError, SERVICE_UNAVAILABLE} from './error';
import {DirectConnectionProvider} from './internal/connection-providers';
import Bookmark from './internal/bookmark';

const READ = 'READ', WRITE = 'WRITE';
/**
 * A driver maintains one or more {@link Session}s with a remote
 * Neo4j instance. Through the {@link Session}s you can send statements
 * and retrieve results from the database.
 *
 * Drivers are reasonably expensive to create - you should strive to keep one
 * driver instance around per Neo4j Instance you connect to.
 *
 * @access public
 */
class Driver {
  /**
   * You should not be calling this directly, instead use {@link driver}.
   * @constructor
   * @param {string} url
   * @param {string} userAgent
   * @param {object} token
   * @param {object} config
   * @protected
   */
  constructor(url, userAgent, token = {}, config = {}) {
    sanitizeConfig(config);

    this._url = url;
    this._userAgent = userAgent;
    this._openSessions = {};
    this._sessionIdGenerator = 0;
    this._token = token;
    this._config = config;
    this._pool = new Pool(
      this._createConnection.bind(this),
      this._destroyConnection.bind(this),
      this._validateConnection.bind(this),
      config.connectionPoolSize
    );

    /**
     * Reference to the connection provider. Initialized lazily by {@link _getOrCreateConnectionProvider}.
     * @type {ConnectionProvider}
     * @protected
     */
    this._connectionProvider = null;
  }

  /**
   * Create a new connection instance.
   * @return {Connection} new connector-api session instance, a low level session API.
   * @access private
   */
  _createConnection(url, release) {
    let sessionId = this._sessionIdGenerator++;
    let conn = connect(url, this._config, this._connectionErrorCode());
    let streamObserver = new _ConnectionStreamObserver(this, conn);
    conn.initialize(this._userAgent, this._token, streamObserver);
    conn._id = sessionId;
    conn._release = () => release(url, conn);

    this._openSessions[sessionId] = conn;
    return conn;
  }

  /**
   * Check that a connection is usable
   * @return {boolean} true if the connection is open
   * @access private
   **/
  _validateConnection(conn) {
    if (!conn.isOpen()) {
      return false;
    }

    const maxConnectionLifetime = this._config.maxConnectionLifetime;
    if (maxConnectionLifetime) {
      const lifetime = Date.now() - conn.creationTimestamp;
      if (lifetime > maxConnectionLifetime) {
        return false;
      }
    }

    return true;
  }

  /**
   * Dispose of a live session, closing any associated resources.
   * @return {Session} new session.
   * @access private
   */
  _destroyConnection(conn) {
    delete this._openSessions[conn._id];
    conn.close();
  }

  /**
   * Acquire a session to communicate with the database. The driver maintains
   * a pool of sessions, so calling this method is normally cheap because you
   * will be pulling a session out of the common pool.
   *
   * This comes with some responsibility - make sure you always call
   * {@link close} when you are done using a session, and likewise,
   * make sure you don't close your session before you are done using it. Once
   * it is returned to the pool, the session will be reset to a clean state and
   * made available for others to use.
   *
   * @param {string} [mode=WRITE] the access mode of this session, allowed values are {@link READ} and {@link WRITE}.
   * @param {string|string[]} [bookmarkOrBookmarks=null] the initial reference or references to some previous
   * transactions. Value is optional and absence indicates that that the bookmarks do not exist or are unknown.
   * @return {Session} new session.
   */
  session(mode, bookmarkOrBookmarks) {
    const sessionMode = Driver._validateSessionMode(mode);
    const connectionProvider = this._getOrCreateConnectionProvider();
    const bookmark = new Bookmark(bookmarkOrBookmarks);
    return this._createSession(sessionMode, connectionProvider, bookmark, this._config);
  }

  static _validateSessionMode(rawMode) {
    const mode = rawMode || WRITE;
    if (mode !== READ && mode !== WRITE) {
      throw newError('Illegal session mode ' + mode);
    }
    return mode;
  }

  // Extension point
  _createConnectionProvider(address, connectionPool, driverOnErrorCallback) {
    return new DirectConnectionProvider(address, connectionPool, driverOnErrorCallback);
  }

  // Extension point
  _createSession(mode, connectionProvider, bookmark, config) {
    return new Session(mode, connectionProvider, bookmark, config);
  }

  // Extension point
  _connectionErrorCode() {
    // connection errors might result in different error codes depending on the driver
    return SERVICE_UNAVAILABLE;
  }

  _getOrCreateConnectionProvider() {
    if (!this._connectionProvider) {
      const driverOnErrorCallback = this._driverOnErrorCallback.bind(this);
      this._connectionProvider = this._createConnectionProvider(this._url, this._pool, driverOnErrorCallback);
    }
    return this._connectionProvider;
  }

  _driverOnErrorCallback(error) {
    const userDefinedOnErrorCallback = this.onError;
    if (userDefinedOnErrorCallback && error.code === SERVICE_UNAVAILABLE) {
      userDefinedOnErrorCallback(error);
    } else {
      // we don't need to tell the driver about this error
    }
  }

  /**
   * Close all open sessions and other associated resources. You should
   * make sure to use this when you are done with this driver instance.
   * @return undefined
   */
  close() {
    for (let sessionId in this._openSessions) {
      if (this._openSessions.hasOwnProperty(sessionId)) {
        this._openSessions[sessionId].close();
      }
      this._pool.purgeAll();
    }
  }
}

/** Internal stream observer used for connection state */
class _ConnectionStreamObserver extends StreamObserver {
  constructor(driver, conn) {
    super();
    this._driver = driver;
    this._conn = conn;
    this._hasFailed = false;
  }

  onError(error) {
    if (!this._hasFailed) {
      super.onError(error);
      if (this._driver.onError) {
        this._driver.onError(error);
      }
      this._hasFailed = true;
    }
  }

  onCompleted(message) {
    if (this._driver.onCompleted) {
      this._driver.onCompleted(message);
    }

    if (this._observer && this._observer.onComplete) {
      this._observer.onCompleted(message);
    }
  }
}

/**
 * @private
 */
function sanitizeConfig(config) {
  const maxConnectionLifetime = config.maxConnectionLifetime;
  if (maxConnectionLifetime) {
    const sanitizedMaxConnectionLifetime = parseInt(maxConnectionLifetime, 10);
    if (sanitizedMaxConnectionLifetime && sanitizedMaxConnectionLifetime > 0) {
      config.maxConnectionLifetime = sanitizedMaxConnectionLifetime;
    } else {
      config.maxConnectionLifetime = null;
    }
  } else {
    config.maxConnectionLifetime = null;
  }
}

export {Driver, READ, WRITE}

export default Driver
