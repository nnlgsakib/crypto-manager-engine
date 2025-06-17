// src/smart-contracts/BatchProcessor.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20 {
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

contract BatchProcessor {
    address public immutable owner;

    event BatchNativeProcessed(address[] recipients, uint256[] amounts, uint256 totalAmount);
    event BatchErc20Processed(address indexed token, address[] recipients, uint256[] amounts, address indexed sender);
    event Withdrawn(address indexed token, uint256 amount, address indexed to);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    function processBatchNative(address[] calldata recipients, uint256[] calldata amounts) external payable {
        require(recipients.length == amounts.length, "Arrays length mismatch");
        require(recipients.length > 0, "No recipients provided");

        uint256 totalAmount = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            require(amounts[i] > 0, "Invalid amount");
            totalAmount += amounts[i];
        }
        require(msg.value >= totalAmount, "Insufficient native currency sent");

        for (uint256 i = 0; i < recipients.length; i++) {
            (bool success, ) = payable(recipients[i]).call{value: amounts[i]}("");
            require(success, "Native transfer failed");
        }

        emit BatchNativeProcessed(recipients, amounts, totalAmount);
    }

    function processBatchErc20(address token, address[] calldata recipients, uint256[] calldata amounts) external {
        require(recipients.length == amounts.length, "Arrays length mismatch");
        require(recipients.length > 0, "No recipients provided");

        IERC20 erc20 = IERC20(token);
        uint256 totalAmount = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            require(amounts[i] > 0, "Invalid amount");
            totalAmount += amounts[i];
        }

        require(erc20.allowance(msg.sender, address(this)) >= totalAmount, "Insufficient allowance");
        require(erc20.balanceOf(msg.sender) >= totalAmount, "Insufficient sender balance");

        for (uint256 i = 0; i < recipients.length; i++) {
            bool success = erc20.transferFrom(msg.sender, recipients[i], amounts[i]);
            require(success, "ERC20 transferFrom failed");
        }

        emit BatchErc20Processed(token, recipients, amounts, msg.sender);
    }

    function withdraw(address token, uint256 amount) external onlyOwner {
        require(amount > 0, "Invalid amount");
        if (token == address(0)) {
            (bool success, ) = payable(owner).call{value: amount}("");
            require(success, "Native withdrawal failed");
        } else {
            bool success = IERC20(token).transfer(owner, amount);
            require(success, "ERC20 withdrawal failed");
        }
        emit Withdrawn(token, amount, owner);
    }
}