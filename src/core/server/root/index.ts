/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { ConnectableObservable, Observable, Subscription } from 'rxjs';
import { first, map, publishReplay, tap } from 'rxjs/operators';

import { Server } from '..';
import { Config, ConfigService, Env } from '../config';
import { Logger, LoggerFactory, LoggingConfig, LoggingService } from '../logging';

/**
 * Top-level entry point to kick off the app and start the Kibana server.
 */
export class Root {
  public readonly logger: LoggerFactory;
  private readonly configService: ConfigService;
  private readonly log: Logger;
  private readonly server: Server;
  private readonly loggingService: LoggingService;
  private loggingConfigSubscription?: Subscription;

  constructor(
    config$: Observable<Config>,
    private readonly env: Env,
    private readonly onShutdown?: (reason?: Error | string) => void
  ) {
    this.loggingService = new LoggingService();
    this.logger = this.loggingService.asLoggerFactory();
    this.log = this.logger.get('root');

    this.configService = new ConfigService(config$, env, this.logger);
    this.server = new Server(this.configService, this.logger, this.env);
  }

  public async start() {
    this.log.debug('starting root');

    try {
      await this.setupLogging();
      await this.server.start();
    } catch (e) {
      await this.shutdown(e);
      throw e;
    }
  }

  public async shutdown(reason?: any) {
    this.log.debug('shutting root down');

    if (reason) {
      if (reason.code === 'EADDRINUSE' && Number.isInteger(reason.port)) {
        reason = new Error(
          `Port ${reason.port} is already in use. Another instance of Kibana may be running!`
        );
      }

      this.log.fatal(reason);
    }

    await this.server.stop();

    if (this.loggingConfigSubscription !== undefined) {
      this.loggingConfigSubscription.unsubscribe();
      this.loggingConfigSubscription = undefined;
    }
    await this.loggingService.stop();

    if (this.onShutdown !== undefined) {
      this.onShutdown(reason);
    }
  }

  private async setupLogging() {
    // Stream that maps config updates to logger updates, including update failures.
    const update$ = this.configService.atPath('logging', LoggingConfig).pipe(
      map(config => this.loggingService.upgrade(config)),
      // This specifically console.logs because we were not able to configure the logger.
      // tslint:disable-next-line no-console
      tap({ error: err => console.error('Configuring logger failed:', err) }),
      publishReplay(1)
    ) as ConnectableObservable<void>;

    // Subscription and wait for the first update to complete and throw if it fails.
    const connectSubscription = update$.connect();
    await update$.pipe(first()).toPromise();

    // Send subsequent update failures to this.shutdown(), stopped via loggingConfigSubscription.
    this.loggingConfigSubscription = update$.subscribe({
      error: err => this.shutdown(err),
    });

    // Add subscription we got from `connect` so that we can dispose both of them
    // at once. We can't inverse this and add consequent updates subscription to
    // the one we got from `connect` because in the error case the latter will be
    // automatically disposed before the error is forwarded to the former one so
    // the shutdown logic won't be called.
    this.loggingConfigSubscription.add(connectSubscription);
  }
}
