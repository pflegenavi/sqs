import { Consumer } from 'sqs-consumer';
import { Producer } from 'sqs-producer';
import type { QueueAttributeName } from '@aws-sdk/client-sqs';
import { SQS } from '@aws-sdk/client-sqs';
import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

import { SqsConfig } from './sqs.config';
import { QueueName, SqsMetadata, SqsQueueOption, SqsQueueType } from './sqs.types';
import { SqsStorage } from './sqs.storage';
import { Message } from './sqs.interfaces';
import { SqsMetadataScanner } from './sqs-metadata.scanner';

@Injectable()
export class SqsService implements OnApplicationBootstrap, OnModuleDestroy {
  public readonly consumers = new Map<QueueName, Consumer>();
  public readonly producers = new Map<QueueName, Producer>();

  public constructor(private readonly scanner: SqsMetadataScanner, private readonly sqsConfig: SqsConfig) {}

  public async onApplicationBootstrap(): Promise<void> {
    const sqsConfig = this.sqsConfig.option;
    const sqsQueueOptions = SqsStorage.getQueueOptions();
    const sqs: SQS = new SQS(sqsConfig);

    const sqsQueueConsumerOptions = sqsQueueOptions.filter(
      (v) => v.type === SqsQueueType.All || v.type === SqsQueueType.Consumer,
    );
    const sqsQueueProducerOptions = sqsQueueOptions.filter(
      (v) => v.type === SqsQueueType.All || v.type === SqsQueueType.Producer,
    );

    sqsQueueConsumerOptions.forEach((option) => {
      this.createConsumer(option, sqs);
    });

    sqsQueueProducerOptions.forEach((option) => {
      this.createProducer(option, sqs);
    });

    for (const consumer of this.consumers.values()) {
      consumer.start();
    }
  }

  private createConsumer(option: SqsQueueOption, sqs: SQS) {
    const { endpoint, accountNumber, region } = this.sqsConfig.option;
    const { name, consumerOptions } = option;
    const metadata: SqsMetadata = this.scanner.sqsMetadatas.get(name);
    if (!metadata) {
      throw new Error('no consumer metadata provided.');
    }
    const {
      messageHandler: { batch, handleMessage },
      eventHandler: eventHandlers,
    } = metadata;

    const consumer = Consumer.create({
      queueUrl: `${endpoint}/${accountNumber}/${name}`,
      region: region as string,
      sqs,
      ...consumerOptions,
      ...(batch
        ? {
            handleMessageBatch: handleMessage,
          }
        : { handleMessage }),
    });

    for (const eventMetadata of eventHandlers) {
      if (eventMetadata) {
        consumer.addListener(eventMetadata.eventName, eventMetadata.handleEvent);
      }
    }
    this.consumers.set(name, consumer);
  }

  private createProducer(option: SqsQueueOption, sqs: SQS) {
    const { endpoint, accountNumber, region } = this.sqsConfig.option;
    const { name, producerOptions } = option;
    if (this.producers.has(name)) {
      throw new Error(`Producer already exists: ${name}`);
    }

    const producer = Producer.create({
      queueUrl: `${endpoint}/${accountNumber}/${name}`,
      region: region as string,
      sqs,
      ...producerOptions,
    });
    this.producers.set(name, producer);
  }

  public onModuleDestroy() {
    for (const consumer of this.consumers.values()) {
      consumer.stop();
    }
  }

  private getQueueInfo(name: QueueName) {
    if (!this.consumers.has(name) && !this.producers.has(name)) {
      throw new Error(`Consumer/Producer does not exist: ${name}`);
    }

    // @ts-expect-error // We are retrieving the SQS we inserted ourselves here.
    const { sqs, queueUrl } = (this.consumers.get(name) ?? this.producers.get(name)) as {
      sqs: SQS;
      queueUrl: string;
    };
    if (!sqs) {
      throw new Error('SQS instance does not exist');
    }

    return {
      sqs,
      queueUrl,
    };
  }
  /**
   * delete all of the messages from queue
   * @param name queue name that wants to purge
   * @returns
   */
  public async purgeQueue(name: QueueName) {
    const { sqs, queueUrl } = this.getQueueInfo(name);
    return sqs.purgeQueue({
      QueueUrl: queueUrl,
    });
  }

  public async getQueueAttributes(name: QueueName) {
    const { sqs, queueUrl } = this.getQueueInfo(name);
    const response = await sqs.getQueueAttributes({
      QueueUrl: queueUrl,
      AttributeNames: ['All'],
    });
    return response.Attributes as { [key in QueueAttributeName]: string };
  }

  public getProducerQueueSize(name: QueueName) {
    if (!this.producers.has(name)) {
      throw new Error(`Producer does not exist: ${name}`);
    }

    return this.producers.get(name).queueSize();
  }

  public send<T = any>(name: QueueName, payload: Message<T> | Message<T>[]) {
    if (!this.producers.has(name)) {
      throw new Error(`Producer does not exist: ${name}`);
    }

    const originalMessages = Array.isArray(payload) ? payload : [payload];
    const messages = originalMessages.map((message) => {
      const { body } = message;
      return {
        ...message,
        body: typeof body !== 'string' ? JSON.stringify(body) : body,
      };
    });

    const producer = this.producers.get(name);
    return producer.send(messages);
  }
}
