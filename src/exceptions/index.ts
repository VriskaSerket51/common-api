export class Exception extends Error {
  public message: string;

  constructor(message: string = "", options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.message = message;
  }
}

export class HttpException extends Exception {
  public status: number;

  constructor(status: number) {
    super();
    this.status = status;
  }
}

export class ResponseException extends Exception {
  public status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}
